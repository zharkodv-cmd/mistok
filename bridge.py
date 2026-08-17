#!/usr/bin/env python3
"""Mistok bridge: HTTP -> WS -> Figma plugin -> back.

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


CHAT_BUSY = False


async def run_chat(ws: web.WebSocketResponse, text: str):
    """Headless Claude Code turn triggered from the plugin's chat input."""
    global CHAT_BUSY
    if CHAT_BUSY:
        await ws.send_str(json.dumps({"type": "chatreply", "text": "⏳ попередній запит ще виконується"}))
        return
    CHAT_BUSY = True
    try:
        import shutil
        env = dict(os.environ)
        env["PATH"] = env.get("PATH", "") + ":/opt/homebrew/bin:/usr/local/bin"
        claude = shutil.which("claude", path=env["PATH"])
        if not claude:
            await ws.send_str(json.dumps({"type": "chatreply", "text": "claude CLI не знайдено в PATH"}))
            return
        await ws.send_str(json.dumps({"type": "chatstatus", "text": "думаю…"}))
        cwd = str(Path.home() / "Code" / "mistok")

        async def attempt(extra):
            proc = await asyncio.create_subprocess_exec(
                claude, "-p", text, "--dangerously-skip-permissions", *extra,
                cwd=cwd, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                out, err = await asyncio.wait_for(proc.communicate(), timeout=300)
            except asyncio.TimeoutError:
                proc.kill()
                return None, "timeout 300s"
            return (out.decode("utf-8", "replace").strip() or None,
                    err.decode("utf-8", "replace").strip())

        out, err = await attempt(["--continue"])
        if out is None and err != "timeout 300s":
            out, err = await attempt([])  # перша розмова в цьому cwd — без --continue
        reply = out or f"(порожня відповідь{': ' + err[:300] if err else ''})"
        await ws.send_str(json.dumps({"type": "chatreply", "text": reply[:6000]}))
        print(f"[chat] {len(text)}b → {len(reply)}b", flush=True)
    except Exception as e:
        try:
            await ws.send_str(json.dumps({"type": "chatreply", "text": f"помилка: {e}"}))
        except Exception:
            pass
    finally:
        CHAT_BUSY = False


async def run_import(ws: web.WebSocketResponse, url: str):
    """Веб-сторінка → редаговані шари Figma (webimport.py, Playwright)."""
    try:
        home = Path.home() / "Code" / "mistok"
        py = str(home / "venv" / "bin" / "python")
        await ws.send_str(json.dumps({"type": "chatstatus", "text": "імпортую " + url + " …"}))
        proc = await asyncio.create_subprocess_exec(
            py, str(home / "webimport.py"), url, cwd=str(home),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=180)
        except asyncio.TimeoutError:
            proc.kill()
            await ws.send_str(json.dumps({"type": "chatreply", "text": "імпорт: таймаут 180с"}))
            return
        tail = (out.decode("utf-8", "replace").strip().splitlines() or ["(порожньо)"])[-1]
        if proc.returncode != 0:
            tail += " | " + err.decode("utf-8", "replace").strip()[-300:]
        await ws.send_str(json.dumps({"type": "chatreply", "text": tail[:1500]}))
        print(f"[import] {url} → rc={proc.returncode}", flush=True)
    except Exception as e:
        print(f"[import] failed: {e}", flush=True)


async def run_spell(ws: web.WebSocketResponse, texts: list):
    """Вичитка текстів headless-Claude'ом і автозастосування виправлень."""
    try:
        import shutil
        env = dict(os.environ)
        env["PATH"] = env.get("PATH", "") + ":/opt/homebrew/bin:/usr/local/bin"
        claude = shutil.which("claude", path=env["PATH"])
        if not claude:
            return
        prompt = (
            "Ти коректор. Виправ орфографічні, граматичні й пунктуаційні помилки в текстах нижче. "
            "Мову кожного тексту зберігай (українська лишається українською, англійська англійською). "
            "Зміст, тон і довжину не міняй — тільки помилки. "
            "Поверни ВИКЛЮЧНО JSON-масив виправлень без пояснень, тільки для текстів зі змінами: "
            '[{"id":"<id>","fixed":"<виправлений текст>"}]. Якщо помилок немає — поверни []. '
            "Тексти: " + json.dumps(texts, ensure_ascii=False)
        )
        proc = await asyncio.create_subprocess_exec(
            claude, "-p", prompt, "--model", "haiku", "--dangerously-skip-permissions",
            cwd=str(Path.home()), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, _err = await asyncio.wait_for(proc.communicate(), timeout=240)
        except asyncio.TimeoutError:
            proc.kill()
            await ws.send_str(json.dumps({"type": "chatreply", "text": "Вичитка: таймаут"}))
            return
        raw = out.decode("utf-8", "replace")
        start, end = raw.find("["), raw.rfind("]")
        fixes = []
        if start != -1 and end > start:
            try:
                fixes = [f for f in json.loads(raw[start:end + 1])
                         if isinstance(f, dict) and f.get("id") and isinstance(f.get("fixed"), str)]
            except json.JSONDecodeError:
                pass
        if not fixes:
            await ws.send_str(json.dumps({"type": "chatreply", "text": "Вичитка: помилок не знайдено ✓"}))
            print("[spell] no fixes", flush=True)
            return
        code = (
            f"const FIX = {json.dumps(fixes, ensure_ascii=False)};"
            "let ok = 0; const miss = [];"
            "for (const f of FIX) {"
            "  const n = await figma.getNodeByIdAsync(f.id);"
            "  if (!n || n.type !== 'TEXT') { miss.push(f.id); continue; }"
            "  try { await h.setText(n, f.fixed); ok++; } catch (e) { miss.push(f.id); }"
            "}"
            "figma.commitUndo();"
            "figma.notify('Вичитка: ' + ok + ' виправлень' + (miss.length ? ', ' + miss.length + ' пропущено' : ''));"
            "return { ok, missed: miss.length };"
        )
        # синхронний urllib у to_thread — інакше дедлок із власним event loop
        req = await asyncio.to_thread(
            urllib_request_json, "http://127.0.0.1:8787/exec", {"code": code, "timeout": 60})
        n_ok = (req.get("value") or {}).get("ok", 0)
        await ws.send_str(json.dumps({"type": "chatreply",
                                      "text": f"Вичитка: {n_ok} виправлень із {len(fixes)} запропонованих"}))
        print(f"[spell] applied {n_ok}/{len(fixes)}", flush=True)
    except Exception as e:
        print(f"[spell] failed: {e}", flush=True)


def urllib_request_json(url, payload):
    import urllib.request
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=70) as r:
        return json.loads(r.read())


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
            if mtype == "chat":
                text = (m.get("text") or "").strip()
                if text.startswith(("http://", "https://")) and " " not in text:
                    asyncio.create_task(run_import(ws, text))  # лінк = веб-імпорт
                else:
                    asyncio.create_task(run_chat(ws, text))
                continue
            if mtype == "spellrequest":
                asyncio.create_task(run_spell(ws, m.get("texts") or []))
                continue
            if mtype == "protorequest":
                try:
                    req = m.get("request") or {}
                    req["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
                    with open("/tmp/mistok-prototype-request.json", "w", encoding="utf-8") as f:
                        json.dump(req, f, ensure_ascii=False, indent=1)
                    print(f"[proto] request: {req.get('frame', {}).get('name')} → /tmp/mistok-prototype-request.json", flush=True)
                    await ws.send_str(json.dumps({"type": "chatreply",
                        "text": "▭ Запит на прототип «" + str(req.get('frame', {}).get('name')) + "» готовий.\nНапиши Claude у сесії: «зроби прототип»"}))
                except OSError as e:
                    print(f"[proto] failed: {e}", flush=True)
                continue
            if mtype == "redesignrequest":
                try:
                    req = m.get("request") or {}
                    req["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
                    with open("/tmp/mistok-redesign-request.json", "w", encoding="utf-8") as f:
                        json.dump(req, f, ensure_ascii=False, indent=1)
                    print(f"[redesign] request: {req.get('frame', {}).get('name')} → /tmp/mistok-redesign-request.json", flush=True)
                    await ws.send_str(json.dumps({"type": "chatreply",
                        "text": "⟳ Запит на редизайн «" + str(req.get('frame', {}).get('name')) + "» готовий.\nНапиши Claude у сесії: «редизайнь секцію»"}))
                except OSError as e:
                    print(f"[redesign] failed: {e}", flush=True)
                continue
            if mtype == "imgrequest":
                # запит на Magnific-генерацію — читає Claude-сесія
                try:
                    req = m.get("request") or {}
                    req["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
                    with open("/tmp/mistok-image-request.json", "w", encoding="utf-8") as f:
                        json.dump(req, f, ensure_ascii=False, indent=1)
                    print(f"[img] request: {len(req.get('slots') or [])} slots → /tmp/mistok-image-request.json", flush=True)
                    await ws.send_str(json.dumps({"type": "chatreply",
                        "text": "✨ Запит на " + str(len(req.get('slots') or [])) + " картинок готовий.\nНапиши Claude у сесії: «встав картинки»"}))
                except OSError as e:
                    print(f"[img] request failed: {e}", flush=True)
                continue
            if mtype == "opreport":
                # звіт кнопок-операцій — лог для Claude-сесій
                try:
                    m["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
                    with open("/tmp/mistok-ops.log", "a", encoding="utf-8") as f:
                        f.write(json.dumps(m, ensure_ascii=False) + "\n")
                    print(f"[op] {m.get('summary')}", flush=True)
                except OSError as e:
                    print(f"[op] log failed: {e}", flush=True)
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
                    # PNG у системний буфер — щоб одразу ⌘V у чат/месенджер
                    import subprocess
                    subprocess.run(
                        ["osascript", "-e",
                         f'set the clipboard to (read (POSIX file "{out}") as «class PNGf»)'],
                        capture_output=True, timeout=10,
                    )
                    print(f"[file] saved {out} ({len(data)} bytes) + clipboard", flush=True)
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
            {"ok": False, "error": "plugin not connected — run the Mistok plugin in Figma"},
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
    ap = argparse.ArgumentParser(description="Mistok bridge server")
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
