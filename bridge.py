#!/usr/bin/env python3
"""Mistok 2.0 bridge: HTTP -> WS -> Figma plugin -> back.

HTTP API (clients like curl / mistok CLI talk here):
    POST /exec     {"code": "...", "timeout": 60} -> {ok, result, value, logs, elapsed_ms}
    GET  /status                                  -> {plugin_connected, pending}

WebSocket (the Figma plugin connects here once it's opened in Figma Desktop):
    WS   /plugin

Run:
    python bridge.py                 # default 127.0.0.1:8787
    python bridge.py --port 9000
    python bridge.py --host 0.0.0.0  # expose on LAN (not recommended)
"""

import argparse
import asyncio
import base64
import json
import os
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from aiohttp import web, WSMsgType


PENDING: dict = {}        # rid -> {"future", "logs", "t0"}
PLUGIN_WS: web.WebSocketResponse | None = None
START_TIME = time.time()
EXEC_COUNT = 0
EXEC_ERRORS = 0
EXEC_TIMES: deque = deque(maxlen=50)

_usage_cache = {"t": 0.0, "data": None}
_token_cache = {"t": 0.0, "token": None}
_limits_cache = {"t": 0.0, "data": None}


def _oauth_token():
    """Claude Code OAuth token from macOS Keychain. Cached 10 min."""
    import subprocess
    now = time.time()
    if _token_cache["token"] and now - _token_cache["t"] < 600:
        return _token_cache["token"]
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        token = json.loads(raw).get("claudeAiOauth", {}).get("accessToken")
    except Exception:
        token = None
    _token_cache["t"], _token_cache["token"] = now, token
    return token


def _claude_limits():
    """Subscription rate-limit bars (session / weekly) from the OAuth usage API. Cached 120s."""
    import urllib.request
    now = time.time()
    if _limits_cache["data"] is not None and now - _limits_cache["t"] < 120:
        return _limits_cache["data"]
    token = _oauth_token()
    if not token:
        return None
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read())
        out = []
        for lim in d.get("limits") or []:
            out.append({
                "kind": lim.get("kind"),
                "percent": lim.get("percent"),           # used, 0-100
                "resets_at": lim.get("resets_at"),
                "severity": lim.get("severity"),
                "model": ((lim.get("scope") or {}).get("model") or {}).get("display_name"),
            })
    except Exception:
        out = None  # keep None so we retry after cache expiry
    _limits_cache["t"], _limits_cache["data"] = now, out
    return out


def _claude_usage():
    """Today's Claude Code usage from ~/.claude/projects JSONL transcripts. Cached 60s."""
    now = time.time()
    if _usage_cache["data"] is not None and now - _usage_cache["t"] < 60:
        return _usage_cache["data"]

    root = Path.home() / ".claude" / "projects"
    today = datetime.now().astimezone().date()
    msgs = in_tok = out_tok = 0
    latest_file, latest_mtime = None, 0.0

    for p in root.glob("*/*.jsonl"):
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        if mtime > latest_mtime:
            latest_mtime, latest_file = mtime, p
        if now - mtime > 26 * 3600:  # only files touched within ~a day
            continue
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"usage"' not in line:
                        continue
                    try:
                        e = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = e.get("timestamp")
                    u = (e.get("message") or {}).get("usage")
                    if not ts or not u:
                        continue
                    try:
                        d = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().date()
                    except ValueError:
                        continue
                    if d != today:
                        continue
                    msgs += 1
                    in_tok += (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
                    out_tok += u.get("output_tokens") or 0
        except OSError:
            continue

    # live session: duration (first→last timestamp), project name, last summary line
    session_min = None
    project = None
    summary = None
    if latest_file and now - latest_mtime < 30 * 60:
        name = latest_file.parent.name  # e.g. -Users-x-Code-iflight-coast
        project = name.split("-Code-", 1)[-1] if "-Code-" in name else name
        first_ts = last_ts = None
        try:
            with open(latest_file, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"type":"summary"' in line:
                        try:
                            summary = json.loads(line).get("summary") or summary
                        except json.JSONDecodeError:
                            pass
                    i = line.find('"timestamp":"')
                    if i == -1:
                        continue
                    ts = line[i + 13:i + 13 + 24].split('"')[0]
                    if first_ts is None:
                        first_ts = ts
                    last_ts = ts
            if first_ts and last_ts:
                t0 = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
                t1 = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
                session_min = max(0, int((t1 - t0).total_seconds() // 60))
        except (OSError, ValueError):
            pass

    data = {"msgs": msgs, "in_tok": in_tok, "out_tok": out_tok,
            "session_min": session_min, "project": project, "summary": summary}
    _usage_cache["t"], _usage_cache["data"] = now, data
    return data


async def stats_pusher(ws: web.WebSocketResponse):
    """Push usage stats to the plugin UI every 60s while it's connected."""
    try:
        while not ws.closed:
            usage = await asyncio.to_thread(_claude_usage)
            limits = await asyncio.to_thread(_claude_limits)
            await ws.send_str(json.dumps({
                "type": "stats",
                "uptime_s": int(time.time() - START_TIME),
                "execs": EXEC_COUNT,
                "errors": EXEC_ERRORS,
                "avg_ms": int(sum(EXEC_TIMES) / len(EXEC_TIMES)) if EXEC_TIMES else None,
                "claude": usage,
                "limits": limits,
            }))
            await asyncio.sleep(60)
    except (ConnectionResetError, asyncio.CancelledError):
        pass


ERROR_HINTS = [
    ("fills and strokes variable bindings must be set on paints directly",
     "use h.bF(node, idx, varId) to bind a fill paint to a variable"),
    ("strokes variable bindings must be set on paints directly",
     "use h.bS(node, idx, varId) to bind a stroke paint to a variable"),
    ("Cannot assign to read only property",
     "node.fills/strokes is frozen — copy via JSON.parse(JSON.stringify(...)) before mutating, or use h.bF()/h.bS()"),
    ("permission not specified in manifest",
     "manifest.json missing a permission — edit plugin/manifest.json, then re-import the plugin in Figma (Plugins → Development → Import plugin from manifest…)"),
    ("unloaded font",
     "use h.setText(node, text) or h.withFonts(root, fn) — they autoload fonts. Or manually: await figma.loadFontAsync(node.fontName)"),
    ("font has not been loaded",
     "use h.setText(node, text) or h.withFonts(root, fn) — they autoload fonts"),
    ("Cannot find font",
     "fontName may be missing or mixed — check node.fontName before loading"),
    ("appendChild",
     "create node, then parent.appendChild(node) BEFORE setting layoutMode/resize/itemSpacing/padding"),
    ("Unable to find a variant",
     "no variant matches those property values — check available: const v = await h.variantsOf(instance); return v.groups"),
    ("Invalid property name",
     "check available variants: const v = await h.variantsOf(instance); return v.groups"),
    ("Invalid value",
     "check variant values: const v = await h.variantsOf(instance); return v.groups"),
    ("setProperties",
     "if 'Unable to find variant' — check available values via h.variantsOf(instance)"),
    ("not a function",
     "API may be deprecated or renamed — check figma.* available methods, or use Async variants"),
]


def find_hint(error_text):
    if not error_text:
        return None
    low = error_text.lower()
    for needle, hint in ERROR_HINTS:
        if needle.lower() in low:
            return hint
    return None


async def plugin_ws_handler(request: web.Request) -> web.WebSocketResponse:
    global PLUGIN_WS
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=16 * 1024 * 1024)
    await ws.prepare(request)

    if PLUGIN_WS is not None and not PLUGIN_WS.closed:
        print(f"[plugin] rejecting second connection from {request.remote}")
        await ws.send_str(json.dumps({"type": "error", "text": "another plugin instance already connected"}))
        await ws.close(code=1008, message=b"already connected")
        return ws

    PLUGIN_WS = ws
    print(f"[plugin] connected from {request.remote}")
    stats_task = asyncio.create_task(stats_pusher(ws))

    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                print(f"[plugin] ws error: {ws.exception()}")
                break
            if msg.type != WSMsgType.TEXT:
                continue

            try:
                m = json.loads(msg.data)
            except json.JSONDecodeError:
                print(f"[plugin] bad json: {msg.data[:200]!r}")
                continue

            mtype = m.get("type")

            if mtype == "hello":
                print(f"[plugin] hello v{m.get('version', '?')}")
                continue
            if mtype == "pong":
                continue
            if mtype == "file":
                # plugin-side export (📷 button) — save to Desktop
                name = os.path.basename(m.get("name") or "export.png")
                try:
                    data = base64.b64decode(m.get("b64") or "")
                    shots_dir = Path.home() / "Desktop" / "mistok-shots"
                    shots_dir.mkdir(exist_ok=True)
                    out = shots_dir / name
                    out.write_bytes(data)
                    print(f"[file] saved {out} ({len(data)} bytes)", flush=True)
                except Exception as e:
                    print(f"[file] save failed: {e}", flush=True)
                continue

            rid = m.get("id")
            entry = PENDING.get(rid)
            if not entry:
                # late reply for a request that already timed out — drop it
                continue

            if mtype == "log":
                entry["logs"].append(m.get("text", ""))
            elif mtype in ("result", "error"):
                if not entry["future"].done():
                    entry["future"].set_result(m)
    finally:
        stats_task.cancel()
        if PLUGIN_WS is ws:
            PLUGIN_WS = None
        print("[plugin] disconnected")
        # Fail any in-flight requests so clients don't hang
        for rid, entry in list(PENDING.items()):
            if not entry["future"].done():
                entry["future"].set_result({
                    "id": rid, "type": "error", "text": "plugin disconnected mid-request",
                })
    return ws


async def exec_handler(request: web.Request) -> web.Response:
    if PLUGIN_WS is None or PLUGIN_WS.closed:
        return web.json_response(
            {"ok": False, "error": "plugin not connected — open Mistok Bridge in Figma"},
            status=503,
        )

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        return web.json_response({"ok": False, "error": "missing or empty 'code'"}, status=400)

    global EXEC_COUNT
    EXEC_COUNT += 1
    timeout = float(body.get("timeout", 60))
    rid = str(uuid.uuid4())
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    PENDING[rid] = {"future": fut, "logs": [], "t0": time.time()}

    try:
        await PLUGIN_WS.send_str(json.dumps({"id": rid, "type": "exec", "code": code}))
    except Exception as e:
        PENDING.pop(rid, None)
        return web.json_response({"ok": False, "error": f"send to plugin failed: {e}"}, status=500)

    try:
        result = await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        PENDING.pop(rid, None)
        return web.json_response(
            {"ok": False, "error": f"timeout after {timeout:.0f}s"}, status=504,
        )

    entry = PENDING.pop(rid)
    elapsed_ms = int((time.time() - entry["t0"]) * 1000)
    EXEC_TIMES.append(elapsed_ms)

    if result.get("type") == "error":
        global EXEC_ERRORS
        EXEC_ERRORS += 1
        error_text = result.get("text", "unknown error")
        return web.json_response(
            {
                "ok": False,
                "error": error_text,
                "hint": find_hint(error_text),
                "stack": result.get("stack"),
                "logs": entry["logs"],
                "elapsed_ms": elapsed_ms,
            },
            status=500,
        )

    return web.json_response({
        "ok": True,
        "result": result.get("text", ""),
        "value": result.get("value"),
        "logs": entry["logs"],
        "elapsed_ms": elapsed_ms,
    })


async def status_handler(_request: web.Request) -> web.Response:
    return web.json_response({
        "plugin_connected": PLUGIN_WS is not None and not PLUGIN_WS.closed,
        "pending": len(PENDING),
    })


async def root_handler(_request: web.Request) -> web.Response:
    return web.json_response({
        "service": "mistok-bridge",
        "version": "2.0",
        "endpoints": {
            "POST /exec": "{code, timeout?} -> {ok, result, value, logs, elapsed_ms}",
            "GET /status": "{plugin_connected, pending}",
            "WS /plugin": "Figma plugin connects here",
        },
    })


def build_app() -> web.Application:
    app = web.Application(client_max_size=16 * 1024 * 1024)
    app.router.add_get("/", root_handler)
    app.router.add_get("/status", status_handler)
    app.router.add_post("/exec", exec_handler)
    app.router.add_get("/plugin", plugin_ws_handler)
    return app


def main():
    ap = argparse.ArgumentParser(description="Mistok 2.0 bridge server")
    ap.add_argument("--host", default="127.0.0.1", help="bind host (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8787, help="bind port (default 8787)")
    args = ap.parse_args()

    print(f"[bridge] listening on http://{args.host}:{args.port}")
    print(f"[bridge] plugin should connect to ws://localhost:{args.port}/plugin")
    print(f"[bridge] try: curl -X POST http://localhost:{args.port}/exec "
          f"-H 'Content-Type: application/json' "
          f"-d '{{\"code\":\"return figma.currentPage.name\"}}'")

    web.run_app(build_app(), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
