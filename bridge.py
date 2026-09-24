#!/usr/bin/env python3
"""Mistok bridge: HTTP -> WS -> Figma plugin -> back.

HTTP API (the mistok CLI, curl, scripts):
    POST /exec     {"code": "...", "timeout": 60} -> {ok, result, value, logs, elapsed_ms}
    GET  /status                                  -> {plugin_connected, pending}

WebSocket (the Figma plugin connects here once it runs in Figma Desktop):
    WS   /plugin

Panel jobs (chat, spellcheck, smart auto-layout, mobile, recreate/redesign/prototype,
photo fill, web import) run headless Claude Code here and reply into the panel chat.

Run:
    python bridge.py                 # 127.0.0.1:8787 (the plugin connects there)
    python bridge.py --port 9000     # tests only
"""

import argparse
import asyncio
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

ROOT = Path(__file__).resolve().parent
TMP = Path("/tmp")                     # request files + ops log; the protocols read them from here
MAX_MSG = 256 * 1024 * 1024            # PNG exports of big frames easily pass 16 MB
PLUGIN_VERSION = "3.0"                 # hello from plugin/ui.html must match
CHAT_SESSION = ROOT / ".chat-session"  # the panel chat's own Claude Code conversation
HEADLESS = ROOT / "headless" / "CLAUDE.md"
PORT = 8787

PLUGIN_WS: web.WebSocketResponse | None = None
PENDING: dict = {}                     # exec id -> {"future", "logs"}
TASKS: dict = {}                       # job kind -> asyncio.Task, one job per kind
EXEC_COUNT = 0
EXEC_ERRORS = 0
EXEC_TIMES: deque = deque(maxlen=50)


# ─── Claude subscription limits (panel bars) ────────────────────────────────

_token = {"t": 0.0, "value": None}
_limits = {"next": 0.0, "data": None}


def _oauth_token():
    """Claude Code OAuth token: macOS Keychain, else ~/.claude/.credentials.json. Cached 10 min."""
    now = time.time()
    if _token["value"] and now - _token["t"] < 600:
        return _token["value"]
    raw = None
    if sys.platform == "darwin":
        try:
            raw = subprocess.run(
                ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            pass
    if not raw:
        try:
            raw = (Path.home() / ".claude" / ".credentials.json").read_text()
        except OSError:
            pass
    try:
        token = json.loads(raw)["claudeAiOauth"]["accessToken"]
    except (TypeError, ValueError, KeyError):
        token = None
    _token.update(t=now, value=token)
    return token


def _claude_limits():
    """Limit bars from the OAuth usage API, refreshed every 2 min. The endpoint 429s
    easily: on any failure the last good bars stay and the next try is in 5 min."""
    now = time.time()
    if now < _limits["next"]:
        return _limits["data"]
    try:
        token = _oauth_token()
        if not token:
            raise ValueError("not logged in to Claude Code")
        req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
            "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20"})
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read())
        _limits["data"] = [{
            "kind": lim.get("kind"),
            "percent": lim.get("percent"),      # used, 0-100
            "resets_at": lim.get("resets_at"),
            "severity": lim.get("severity"),
            "model": ((lim.get("scope") or {}).get("model") or {}).get("display_name"),
        } for lim in d.get("limits") or []]
        _limits["next"] = now + 120
    except Exception as e:
        if isinstance(e, urllib.error.HTTPError) and e.code == 401:
            _token["value"] = None              # Claude Code refreshed it; re-read next time
        _limits["next"] = now + 300
    return _limits["data"]


async def stats_pusher(ws: web.WebSocketResponse):
    """Exec counter + limit bars → panel, every 60 s while connected."""
    try:
        while not ws.closed:
            limits = await asyncio.to_thread(_claude_limits)
            await ws.send_str(json.dumps({
                "type": "stats", "execs": EXEC_COUNT, "errors": EXEC_ERRORS,
                "avg_ms": int(sum(EXEC_TIMES) / len(EXEC_TIMES)) if EXEC_TIMES else None,
                "limits": limits,
            }))
            await asyncio.sleep(60)
    except (ConnectionError, RuntimeError, asyncio.CancelledError):
        pass


# ─── exec: JS round-trip through the plugin ─────────────────────────────────

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
    low = (error_text or "").lower()
    return next((hint for needle, hint in ERROR_HINTS if needle.lower() in low), None)


async def plugin_exec(code: str, timeout: float = 60) -> dict:
    """Run JS in the plugin. Returns the /exec response body plus its HTTP "status"."""
    global EXEC_COUNT, EXEC_ERRORS
    ws = PLUGIN_WS
    if ws is None or ws.closed:
        return {"ok": False, "error": "plugin not connected — run the Mistok plugin in Figma", "status": 503}
    EXEC_COUNT += 1
    rid = str(uuid.uuid4())
    entry = PENDING[rid] = {"future": asyncio.get_running_loop().create_future(), "logs": []}
    t0 = time.time()
    try:
        await ws.send_str(json.dumps({"id": rid, "type": "exec", "code": code}))
        msg = await asyncio.wait_for(entry["future"], timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"timeout after {timeout:.0f}s", "status": 504}
    except (ConnectionError, RuntimeError) as e:
        return {"ok": False, "error": f"send to plugin failed: {e}", "status": 500}
    finally:
        PENDING.pop(rid, None)
    elapsed_ms = int((time.time() - t0) * 1000)
    EXEC_TIMES.append(elapsed_ms)
    if msg.get("type") == "error":
        EXEC_ERRORS += 1
        error = msg.get("text") or "unknown error"
        return {"ok": False, "error": error, "hint": find_hint(error), "stack": msg.get("stack"),
                "logs": entry["logs"], "elapsed_ms": elapsed_ms, "status": 500}
    return {"ok": True, "result": msg.get("text", ""), "value": msg.get("value"),
            "logs": entry["logs"], "elapsed_ms": elapsed_ms}


async def plugin_value(code: str, timeout: float = 60):
    """plugin_exec for the bridge's own jobs: the returned value, or RuntimeError."""
    res = await plugin_exec(code, timeout)
    if not res["ok"]:
        raise RuntimeError(res["error"])
    return res.get("value")


async def preview(node_id: str):
    """≤640px PNG of a node as a data URI for the panel chat; None if it can't be made."""
    code = (f"const n = await figma.getNodeByIdAsync({json.dumps(node_id)});"
            "if (!n) return null;"
            "const s = Math.min(1, 640 / Math.max(n.width, 1));"
            "return figma.base64Encode(await n.exportAsync({format: 'PNG', constraint: {type: 'SCALE', value: s}}));")
    try:
        b64 = await plugin_value(code, 60)
    except RuntimeError:
        return None
    return "data:image/png;base64," + b64 if isinstance(b64, str) and len(b64) < 3_500_000 else None


# ─── headless Claude Code ───────────────────────────────────────────────────

# one-shot text-in/JSON-out calls: no tools, hooks, plugins, MCP or saved session
LEAN = ["--safe-mode", "--tools", "", "--no-session-persistence"]


def _claude_cmd():
    """claude binary + env. MISTOK_CLAUDE (set by install.sh) wins; else PATH search.
    The venv and the repo go first on PATH (python3 with playwright, the mistok CLI),
    the usual install dirs after — launchd's PATH is bare."""
    dirs = [str(Path(sys.executable).parent), str(ROOT), str(Path.home() / ".local" / "bin"),
            "/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "")]
    env = {**os.environ, "PATH": os.pathsep.join(dirs)}
    env.pop("CLAUDECODE", None)  # started from inside a Claude Code session: allow nesting
    exe = os.environ.get("MISTOK_CLAUDE") or shutil.which("claude", path=env["PATH"])
    if not exe:
        raise RuntimeError("claude CLI not found — install Claude Code, log in, re-run install.sh")
    return exe, env


def _kill(proc):
    """Kill the job's whole process group — claude plus every tool it spawned."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)  # start_new_session → pid is the group id
    except (AttributeError, OSError):        # Windows, or already gone
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass


async def claude(prompt: str, args: list, *, timeout: float, cwd: Path = ROOT, on_event=None):
    """`claude -p <args>` with the prompt on stdin (no argv limits, no '-' parsing surprises).
    Returns (returncode, output). With on_event: stream-json mode, each event is passed to
    `await on_event(evt)` and the output is the tail of non-JSON lines."""
    exe, env = _claude_cmd()
    proc = await asyncio.create_subprocess_exec(
        exe, "-p", *args, cwd=str(cwd), env=env, limit=MAX_MSG, start_new_session=True,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT if on_event else asyncio.subprocess.PIPE)
    try:
        if on_event is None:
            out, err = await asyncio.wait_for(proc.communicate(prompt.encode()), timeout)
            text = out + (b"\n" + err if proc.returncode else b"")  # stderr only to explain a failure
            return proc.returncode, text.decode("utf-8", "replace").strip()
        proc.stdin.write(prompt.encode())
        await proc.stdin.drain()
        proc.stdin.close()
        tail = deque(maxlen=20)

        async def pump():
            async for line in proc.stdout:
                try:
                    evt = json.loads(line)
                except ValueError:
                    tail.append(line.decode("utf-8", "replace").strip())
                    continue
                if isinstance(evt, dict):
                    await on_event(evt)
            return await proc.wait()

        rc = await asyncio.wait_for(pump(), timeout)
        return rc, "\n".join(tail)
    except asyncio.TimeoutError:
        raise RuntimeError(f"timeout after {int(timeout)}s") from None
    finally:
        _kill(proc)


async def ask_json(prompt: str, *, model: str, timeout: float, kind: str):
    """One-shot structured answer: the outermost {...} or [...] of the reply, parsed; None if absent."""
    rc, out = await claude(prompt, ["--model", model, *LEAN], timeout=timeout)
    starts = [i for i in (out.find("{"), out.find("[")) if i != -1]
    if rc == 0 and starts:
        s = min(starts)
        e = out.rfind("}" if out[s] == "{" else "]")
        try:
            return json.loads(out[s:e + 1])
        except ValueError:
            pass
    print(f"[{kind}] no JSON in reply (rc={rc}): {out[:200]!r}", flush=True)
    return None


# ─── panel jobs ─────────────────────────────────────────────────────────────

async def send_plugin(payload: dict):
    """Send to the CURRENT plugin connection — it may have reconnected since the job began."""
    ws = PLUGIN_WS
    if ws is not None and not ws.closed:
        try:
            await ws.send_str(json.dumps(payload))
        except (ConnectionError, RuntimeError):
            pass


async def status(kind: str, text: str):
    await send_plugin({"type": "chatstatus", "task": kind, "text": text})


async def spawn(kind: str, job, *args):
    """Run job(*args) in the background, one per kind. Its return value (text, or a dict
    with text/img/node) is the final reply; errors and cancels reply too, so the panel
    never hangs on a spinner."""
    if kind in TASKS:
        await send_plugin({"type": "chatreply", "task": kind, "text": f"⏳ {kind}: the previous run is still going"})
        return

    async def run():
        try:
            res = await job(*args)
        except asyncio.CancelledError:
            res = "✕ cancelled"
        except Exception as e:
            print(f"[{kind}] failed: {e!r}", flush=True)
            res = f"{kind} failed: {e}"
        finally:
            TASKS.pop(kind, None)
        await send_plugin({"type": "chatreply", "task": kind,
                           **(res if isinstance(res, dict) else {"text": str(res)})})

    TASKS[kind] = asyncio.create_task(run())


def save_request(name: str, req: dict) -> dict:
    """Request files are the protocols' input (and let a regular Claude session take over)."""
    req["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
    (TMP / name).write_text(json.dumps(req, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[request] {name}: {(req.get('frame') or {}).get('name')}", flush=True)
    return req


async def run_chat(text: str, model: str | None, effort: str | None):
    """Panel chat → headless Claude Code in the repo (its CLAUDE.md, all tools, the mistok CLI).
    Keeps a conversation of its own: `--continue` would hijack a terminal session in this folder."""
    opts = (["--model", model] if model else []) + (["--effort", effort] if effort else [])
    await status("chat", "thinking…" + (f" ({' · '.join(filter(None, [model, effort]))})" if opts else ""))
    sid = CHAT_SESSION.read_text().strip() if CHAT_SESSION.exists() else ""
    flag = "--resume" if sid else "--session-id"
    sid = sid or str(uuid.uuid4())
    rc, out = await claude(text, [flag, sid, "--dangerously-skip-permissions", *opts], timeout=600)
    if rc and flag == "--resume" and "No conversation found" in out:  # session file outlived its transcript
        sid = str(uuid.uuid4())
        rc, out = await claude(text, ["--session-id", sid, "--dangerously-skip-permissions", *opts], timeout=600)
    if rc:
        return f"chat failed: {out[-300:]}"
    CHAT_SESSION.write_text(sid)
    return out[:6000] or "(empty reply)"


async def run_import(url: str):
    """Web page → editable Figma layers (webimport.py, Playwright)."""
    await status("import", f"importing {url} …")
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(ROOT / "webimport.py"), url, "--port", str(PORT), cwd=str(ROOT),
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 180)
    except asyncio.TimeoutError:
        raise RuntimeError("timeout after 180s") from None
    finally:
        _kill(proc)
    lines = out.decode("utf-8", "replace").strip().splitlines()
    return lines[-1][:1500] if lines else "import: no output"


SPELL_PROMPT = (
    "You are a careful proofreader for UI copy in Figma. Fix ONLY objective errors: "
    "spelling, grammar, punctuation. "
    "Preserve each text's language (Ukrainian stays Ukrainian, English stays English), "
    "meaning, tone, casing, line breaks and emoji exactly. "
    "Headings and labels are legitimate sentence fragments — never 'complete' them or add final periods. "
    "Never touch brand/product names, numbers, URLs, emails, code or ids. "
    "Ukrainian: correct apostrophe (м'який) and «» quotes count as punctuation fixes; "
    "do not restyle otherwise-correct text. "
    "Return ONLY a JSON array of fixes, no explanations, only for texts that changed: "
    '[{"id":"<id>","fixed":"<corrected text>"}]. If there are no errors, return []. '
    "Texts: "
)


async def run_spell(texts: list):
    """Proofread the selection's texts with haiku and apply the fixes — skipping any text
    edited in Figma meanwhile."""
    if not texts:
        return "Spellcheck: no texts"
    await status("spell", f"spellchecking {len(texts)} texts…")
    orig = {t.get("id"): t.get("text") for t in texts}
    fixes = await ask_json(SPELL_PROMPT + json.dumps(texts, ensure_ascii=False),
                           model="haiku", timeout=240, kind="spell")
    if not isinstance(fixes, list):
        return "Spellcheck: couldn't read Claude's answer — try again"
    fixes = [{"id": f["id"], "fixed": f["fixed"], "orig": orig[f["id"]]} for f in fixes
             if isinstance(f, dict) and f.get("id") in orig and isinstance(f.get("fixed"), str)
             and f["fixed"] != orig[f["id"]]]
    if not fixes:
        return "Spellcheck: no errors found ✓"
    code = (
        f"const FIX = {json.dumps(fixes, ensure_ascii=False)};"
        "let ok = 0, stale = 0;"
        "for (const f of FIX) {"
        "  const n = await figma.getNodeByIdAsync(f.id);"
        "  if (!n || n.type !== 'TEXT' || n.characters !== f.orig) { stale++; continue; }"
        "  try { await h.replaceText(n, f.fixed); ok++; } catch (e) { stale++; }"
        "}"
        "figma.notify('Spellcheck: ' + ok + ' fixes' + (stale ? ', ' + stale + ' skipped' : ''));"
        "return { ok, stale };"
    )
    v = await plugin_value(code, 60) or {}
    return (f"Spellcheck: {v.get('ok', 0)} of {len(fixes)} fixes applied"
            + (f" ({v['stale']} skipped: text changed in Figma meanwhile)" if v.get("stale") else ""))


AL_PROMPT = (
    "You are a senior product designer preparing Figma frames for auto-layout. "
    "For each frame you get its size and direct children: id, name, type, x, y, w, h, "
    "plus flags — text (content), bg (covers most of the frame), img (has image fill), "
    "al (already has auto-layout).\n"
    "Decide the STRUCTURE only — grouping, order, direction, absolutes. "
    "Do NOT output gap or padding numbers: they are computed from geometry.\n"
    "Rules:\n"
    "- Every child id appears EXACTLY once in the output — inside one group's ids or as a node. "
    "Never drop or duplicate an id.\n"
    "- absolute:true ONLY for true background/decor layers: bg:true, or a layer that clearly sits "
    "behind/over other children as decoration. Real content is NEVER absolute. List absolutes first.\n"
    "- Group only children that visually align in one row or column: icon+label, label+value, "
    "button rows, card innards. If items overlap or their spacing is wildly irregular, "
    "keep them as standalone nodes instead of forcing a group.\n"
    "- Frame direction = the dominant stacking axis of the resulting top-level entries.\n"
    "Output ONLY JSON, no prose:\n"
    '{"frames":[{"frameId":"<id>","direction":"VERTICAL|HORIZONTAL",'
    '"children":[<entries in final visual order>]}]}\n'
    'Entry forms: {"type":"group","name":"<short>","direction":"HORIZONTAL|VERTICAL","ids":["..."]} | '
    '{"type":"node","id":"..."} | {"type":"node","id":"...","absolute":true}\n'
    "Frames: "
)


async def plan_layout(kind: str, frames: list) -> list:
    """Claude (sonnet) plans structure for ≤4 frames per call; the plugin applies it with
    gaps/paddings measured from geometry (h.alApply) and an axis heuristic for whatever
    the plan missed — a failed or timed-out plan still gets the heuristic."""
    chunks = [frames[i:i + 4] for i in range(0, len(frames), 4)]
    made = []
    for n, chunk in enumerate(chunks, 1):
        await status(kind, f"planning auto-layout {n}/{len(chunks)}…")
        try:
            plan = await ask_json(AL_PROMPT + json.dumps(chunk, ensure_ascii=False),
                                  model="sonnet", timeout=240, kind=kind)
        except RuntimeError as e:
            print(f"[{kind}] plan failed, heuristic only: {e}", flush=True)
            plan = None
        if not isinstance(plan, dict) or not isinstance(plan.get("frames"), list):
            plan = {"frames": []}
        made += await plugin_value(
            f"return await h.alApply({json.dumps(plan, ensure_ascii=False)}, "
            f"{json.dumps([f['id'] for f in chunk])});", 90) or []
    return made


async def run_alplan(req: dict):
    made = await plan_layout("autolayout", req.get("frames") or [])
    return "Smart auto-layout applied: " + (", ".join(made) or "structure set")


async def run_mobileplan(req: dict):
    """📱 the clones' free-placed frames get auto-layout first, then h.mreflow squeezes each to 375."""
    made = await plan_layout("mobile", req.get("frames") or [])
    sizes = []
    for clone_id in req.get("cloneIds") or []:
        d = await plugin_value(f"return await h.mreflow({json.dumps(clone_id)});", 120) or {}
        sizes.append(f"{d.get('w', '?')}×{d.get('h', '?')}")
    return f"Mobile 375 ready: {len(made)} groups planned, reflowed to {', '.join(sizes) or '—'}"


PROTOCOLS = {  # job kind → request file, headless command (headless/CLAUDE.md), panel label
    "recreate": ("mistok-design-request.json", "recreate the design", "◆ recreating"),
    "redesign": ("mistok-redesign-request.json", "redesign the section", "⟳ redesigning"),
    "prototype": ("mistok-prototype-request.json", "build the prototype", "▭ building prototype"),
}
PROTOCOL_MSGS = {"designrequest": "recreate", "redesignrequest": "redesign", "protorequest": "prototype"}


async def run_protocol(kind: str, req: dict):
    """A request-file protocol in a headless session (opus unless the panel picks a model),
    tool progress streamed into the panel; the reply previews the [node:ID] it reports.
    Runs outside the repo so only the lean headless/CLAUDE.md context applies."""
    fname, phrase, label = PROTOCOLS[kind]
    save_request(fname, req)
    await status(kind, label + "…")
    result, last = {}, 0.0

    async def on_event(evt):
        nonlocal last
        if evt.get("type") == "result":
            result.update(evt)
        elif evt.get("type") == "assistant" and time.time() - last > 2:
            for block in (evt.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    last = time.time()
                    inp = block.get("input") or {}
                    hint = str(inp.get("command") or inp.get("file_path") or inp.get("description") or "")
                    await status(kind, f"{label}: {block.get('name', '')}" + (f" · {hint[:48]}" if hint else ""))
                    break

    workdir = TMP / "mistok-run"
    workdir.mkdir(exist_ok=True)
    args = ["--model", req.get("model") or "opus", *(["--effort", req["effort"]] if req.get("effort") else []),
            "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
            "--append-system-prompt", HEADLESS.read_text(encoding="utf-8")]
    rc, tail = await claude(phrase, args, timeout=1800, cwd=workdir, on_event=on_event)
    text = str(result.get("result") or "").strip()
    if not text:
        return f"{label}: no result ({result.get('subtype') or f'exit {rc}'}) {tail[-300:]}".strip()
    m = re.search(r"\[node:(\d+:\d+)\]", text)
    reply = {"text": re.sub(r"\s*\[node:\d+:\d+\]", "", text)[:400]}
    if m:
        reply["node"] = m.group(1)
        img = await preview(m.group(1))
        if img:
            reply["img"] = img
    return reply


# ─── photo fill (Freepik) ───────────────────────────────────────────────────

BAD_TITLE = ("3d", "render", "generative", "ai image", "miniature", "toy", "lineart",
             "drawing", "illustration", "cartoon", "vector")
RANK_PROMPT = (
    "Rank stock photo candidates for a premium brand design. Judge relevance by each group's "
    "context texts. For each group pick the best distinct photos (real photography feel, "
    "editorial quality, no stock cliches, no visible text/watermarks), enough to cover need. "
    'Return ONLY JSON: {"groups":[{"i":<group index>,"ids":[<candidate ids in order>]}]}. Data: '
)


def _freepik_key():
    """FREEPIK_API_KEY from the environment or the repo's .env."""
    if os.environ.get("FREEPIK_API_KEY"):
        return os.environ["FREEPIK_API_KEY"].strip()
    try:
        for line in (ROOT / ".env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == "FREEPIK_API_KEY" and v.strip():
                return v.strip().strip("\"'")
    except OSError:
        pass
    return None


def _shrink(data: bytes, px: int = 2048) -> bytes:
    """Fit a photo into px (macOS sips); elsewhere it goes as is (Figma's cap is 4096)."""
    if not shutil.which("sips"):
        return data
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "photo.jpg"
        p.write_bytes(data)
        subprocess.run(["sips", "-Z", str(px), str(p)], capture_output=True, timeout=60)
        return p.read_bytes()


async def run_images(req: dict):
    """✨ image slots ← Freepik stock photos: search per slot context, haiku ranks, insert.
    Without a key the saved request waits for a Claude session («insert the images»)."""
    save_request("mistok-image-request.json", req)
    slots = req.get("slots") or []
    key = _freepik_key()
    if not key:
        return ("Request saved to /tmp/mistok-image-request.json. One-click fill needs FREEPIK_API_KEY "
                "in mistok/.env (free key: freepik.com/developers); or tell Claude in a session: insert the images")
    if not slots:
        return "no image slots in the request"
    groups = {}
    for s in slots:
        sig = " | ".join(s.get("context") or [])[:120] or s.get("name") or "photo"
        groups.setdefault(sig, []).append(s)
    await status("imggen", f"searching photos: {len(groups)} themes / {len(slots)} slots…")
    async with ClientSession(headers={"x-freepik-api-key": key}, timeout=ClientTimeout(total=60)) as http:
        cands = []
        for sig, ss in groups.items():
            ar = ss[0]["w"] / max(ss[0]["h"], 1)
            orient = "landscape" if ar > 1.25 else "portrait" if ar < 0.8 else "square"
            params = {"term": sig.split("|")[0].strip()[:60] or "photo", "limit": "30", "page": "1",
                      "filters[content_type][photo]": "1", f"filters[orientation][{orient}]": "1",
                      "filters[ai-generated][excluded]": "1"}
            async with http.get("https://api.freepik.com/v1/resources", params=params) as r:
                data = await r.json(content_type=None)
                if r.status != 200:
                    raise RuntimeError(f"Freepik search HTTP {r.status}: {str(data)[:160]}")
            cands.append([{"id": it.get("id"), "title": it.get("title")} for it in data.get("data") or []
                          if not any(b in (it.get("title") or "").lower() for b in BAD_TITLE)][:15])
        ranked = {}
        if any(cands):
            plan = await ask_json(RANK_PROMPT + json.dumps(
                [{"i": i, "context": sig, "need": len(ss), "candidates": c}
                 for i, ((sig, ss), c) in enumerate(zip(groups.items(), cands))], ensure_ascii=False),
                model="haiku", timeout=120, kind="imggen")
            if isinstance(plan, dict):
                ranked = {g.get("i"): g.get("ids") for g in plan.get("groups") or [] if isinstance(g, dict)}
        done, used = 0, set()
        for i, ((sig, ss), c) in enumerate(zip(groups.items(), cands)):
            queue = [x for x in (ranked.get(i) or [x["id"] for x in c]) if x not in used]
            for slot in ss:
                if not queue:
                    break
                rid = queue.pop(0)
                used.add(rid)
                await status("imggen", f"inserting {done + 1}/{len(slots)}…")
                try:
                    async with http.get(f"https://api.freepik.com/v1/resources/{rid}/download") as r:
                        dl = await r.json(content_type=None)
                    url = (dl.get("data") or {}).get("url") or dl.get("url")
                    if not url:
                        continue
                    async with http.get(url) as r:
                        body = await r.read()
                    b64 = base64.b64encode(await asyncio.to_thread(_shrink, body)).decode()
                    await plugin_value(
                        f"const n = await figma.getNodeByIdAsync({json.dumps(slot['id'])});"
                        "if (!n) throw new Error('slot is gone');"
                        f"const img = figma.createImage(figma.base64Decode({json.dumps(b64)}));"
                        "n.fills = [{type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL'}];", 60)
                    done += 1
                except Exception as e:
                    print(f"[imggen] slot {slot.get('id')}: {e!r}", flush=True)
    reply = {"text": f"inserted {done}/{len(slots)} photos ({len(groups)} themes, Freepik)"}
    fid = (req.get("frame") or {}).get("id")
    if fid and done:
        img = await preview(fid)
        if img:
            reply["img"] = img
    return reply


# ─── plugin side of the bridge ──────────────────────────────────────────────

def save_shot(name: str, b64: str):
    """📷 button: PNG → ~/Desktop/mistok-shots + (macOS) the system clipboard for ⌘V."""
    out = Path.home() / "Desktop" / "mistok-shots" / os.path.basename(name or "export.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(b64 or ""))
    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e", f'set the clipboard to (read (POSIX file "{out}") as «class PNGf»)'],
                       capture_output=True, timeout=10)
    print(f"[file] saved {out}", flush=True)


async def on_plugin_message(m: dict):
    t = m.get("type")
    if t in ("result", "error", "log"):
        entry = PENDING.get(m.get("id"))
        if entry and t == "log":
            entry["logs"].append(m.get("text", ""))
        elif entry and not entry["future"].done():
            entry["future"].set_result(m)
    elif t == "hello":
        print(f"[plugin] hello v{m.get('version', '?')}", flush=True)
        if m.get("version") != PLUGIN_VERSION:
            await send_plugin({"type": "chatreply", "task": "chat", "text":
                               f"The Mistok plugin running in Figma (v{m.get('version')}) is older than the "
                               f"bridge (v{PLUGIN_VERSION}) — re-run it: Plugins → Development → Mistok (⌘⌥P)"})
    elif t == "chat":
        text = (m.get("text") or "").strip()
        if re.fullmatch(r"https?://\S+", text):
            await spawn("import", run_import, text)
        elif text:
            await spawn("chat", run_chat, text, m.get("model"), m.get("effort"))
    elif t == "chatreset":
        CHAT_SESSION.unlink(missing_ok=True)
    elif t == "spellrequest":
        await spawn("spell", run_spell, m.get("texts") or [])
    elif t == "alplanrequest":
        await spawn("autolayout", run_alplan, m.get("request") or {})
    elif t == "mobileplanrequest":
        await spawn("mobile", run_mobileplan, m.get("request") or {})
    elif t in PROTOCOL_MSGS:
        await spawn(PROTOCOL_MSGS[t], run_protocol, PROTOCOL_MSGS[t], m.get("request") or {})
    elif t == "imgrequest":
        await spawn("imggen", run_images, m.get("request") or {})
    elif t == "kill":
        running = list(TASKS)
        for task in TASKS.values():
            task.cancel()
        await send_plugin({"type": "killed", "running": running})
        print(f"[kill] {running}", flush=True)
    elif t == "opreport":
        # op reports → JSONL for Claude sessions («look at what Clean did»)
        m["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
        with open(TMP / "mistok-ops.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
        print(f"[op] {m.get('summary')}", flush=True)
    elif t == "file":
        await asyncio.to_thread(save_shot, m.get("name"), m.get("b64"))


async def plugin_ws_handler(request: web.Request) -> web.WebSocketResponse:
    global PLUGIN_WS
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG)
    await ws.prepare(request)

    if PLUGIN_WS is not None and not PLUGIN_WS.closed:
        print(f"[plugin] rejecting second connection from {request.remote}", flush=True)
        await ws.send_str(json.dumps({"type": "error", "text": "another plugin instance already connected"}))
        await ws.close(code=1008, message=b"already connected")
        return ws

    PLUGIN_WS = ws
    print(f"[plugin] connected from {request.remote}", flush=True)
    stats_task = asyncio.create_task(stats_pusher(ws))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                print(f"[plugin] ws error: {ws.exception()}", flush=True)
                break
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                m = json.loads(msg.data)
            except ValueError:
                print(f"[plugin] bad json: {msg.data[:200]!r}", flush=True)
                continue
            try:
                await on_plugin_message(m)
            except Exception as e:  # one bad message must not drop the connection
                print(f"[plugin] {m.get('type')} failed: {e!r}", flush=True)
    finally:
        stats_task.cancel()
        if PLUGIN_WS is ws:
            PLUGIN_WS = None
        for entry in PENDING.values():  # in-flight execs fail now instead of timing out
            if not entry["future"].done():
                entry["future"].set_result({"type": "error", "text": "plugin disconnected mid-request"})
        print("[plugin] disconnected", flush=True)
    return ws


# ─── HTTP ───────────────────────────────────────────────────────────────────

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _browser_ok(request: web.Request) -> bool:
    """No Origin: a local process (CLI, curl, scripts). Browsers always send one; the only
    browser allowed is Figma's plugin iframe on /plugin (opaque "null" origin, Figma's UA) —
    a sandboxed iframe in a regular browser has the same origin but not the UA."""
    origin = request.headers.get("Origin")
    return origin is None or (request.path == "/plugin" and origin == "null"
                              and "Figma/" in request.headers.get("User-Agent", ""))


@web.middleware
async def local_only(request: web.Request, handler):
    """Web pages can reach localhost too: refuse a foreign Host (DNS rebinding) and
    any browser that isn't the Figma plugin (CSRF, drive-by WebSocket)."""
    if request.url.host not in LOCAL_HOSTS or not _browser_ok(request):
        print(f"[bridge] refused {request.method} {request.path} (host {request.host}, "
              f"origin {request.headers.get('Origin')})", flush=True)
        return web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    return await handler(request)


async def exec_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        code, timeout = body.get("code"), float(body.get("timeout", 60))
    except (ValueError, TypeError, AttributeError):
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
    if not isinstance(code, str) or not code.strip():
        return web.json_response({"ok": False, "error": "missing or empty 'code'"}, status=400)
    res = await plugin_exec(code, timeout)
    status_code = res.pop("status", 200)
    return web.json_response(res, status=status_code)


async def status_handler(_request: web.Request) -> web.Response:
    return web.json_response({"plugin_connected": PLUGIN_WS is not None and not PLUGIN_WS.closed,
                              "pending": len(PENDING)})


async def root_handler(_request: web.Request) -> web.Response:
    return web.json_response({
        "service": "mistok-bridge",
        "version": PLUGIN_VERSION,
        "endpoints": {
            "POST /exec": "{code, timeout?} -> {ok, result, value, logs, elapsed_ms}",
            "GET /status": "{plugin_connected, pending}",
            "WS /plugin": "Figma plugin connects here",
        },
    })


def build_app() -> web.Application:
    app = web.Application(client_max_size=MAX_MSG, middlewares=[local_only])
    app.router.add_get("/", root_handler)
    app.router.add_get("/status", status_handler)
    app.router.add_post("/exec", exec_handler)
    app.router.add_get("/plugin", plugin_ws_handler)
    return app


def main():
    global PORT
    ap = argparse.ArgumentParser(description="Mistok bridge server (127.0.0.1 only)")
    ap.add_argument("--port", type=int, default=PORT, help="port (default 8787 — the plugin connects there)")
    PORT = ap.parse_args().port
    sys.stdout.reconfigure(line_buffering=True)  # launchd log stays live
    print(f"[bridge] listening on http://127.0.0.1:{PORT}")
    print(f"[bridge] plugin should connect to ws://localhost:{PORT}/plugin")
    # the plugin's WebSocket never "finishes": don't let a graceful shutdown wait 60 s for it
    web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, shutdown_timeout=3)


if __name__ == "__main__":
    main()
