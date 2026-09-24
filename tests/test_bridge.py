#!/usr/bin/env python3
"""Bridge self-test: the real bridge in-process, driven by a fake plugin (WebSocket)
and a fake `claude` CLI — exec round-trip, local-only guard, panel jobs, cancel.

    ./venv/bin/python tests/test_bridge.py
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from aiohttp import ClientSession, WSServerHandshakeError
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import bridge  # noqa: E402

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
args, prompt = sys.argv[1:], sys.stdin.read()
sessions = sys.argv[0] + ".sessions"
open(sys.argv[0] + ".pid", "w").write(str(os.getpid()))
if "slow" in prompt:
    time.sleep(60)
if "--resume" in args:
    sid = args[args.index("--resume") + 1]
    if not os.path.exists(sessions) or sid not in open(sessions).read():
        sys.exit(print(f"No conversation found with session ID: {sid}", file=sys.stderr) or 1)
if "--session-id" in args:
    open(sessions, "a").write(args[args.index("--session-id") + 1] + "\n")
if "stream-json" in args:
    for evt in ({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": "Bash", "input": {"command": "mistok spec 1:2"}}]}},
                {"type": "result", "subtype": "success", "result": "Built «Hero v2» [node:1:9]"}):
        print(json.dumps(evt), flush=True)
elif "proofreader" in prompt:
    print('```json\n[{"id":"1:5","fixed":"Receive the license"},{"id":"9:9","fixed":"x"}]\n```')
elif "auto-layout" in prompt:
    print("sorry, no plan")                    # unparseable → the heuristic still runs
else:
    print("echo: " + prompt)
'''


def plugin_reply(code):
    """What the fake plugin answers to an exec."""
    if "h.replaceText" in code:
        assert '"orig": "Recieve teh license"' in code and "9:9" not in code, code
        return {"ok": 1, "stale": 0}
    if "h.alApply" in code:
        assert '{"frames": []}' in code, code
        return ["rowx2"]
    if "exportAsync" in code:
        return "iVBORw0KGgo="
    if "1+1" in code:
        return 2
    return "ok"


FIGMA = {"Origin": "null", "User-Agent": "Mozilla/5.0 (Macintosh) Figma/126.8.18 Chrome/148.0 Electron/42.11.1"}


async def fake_plugin(http, url, inbox, version=bridge.PLUGIN_VERSION, answer=True):
    ws = await http.ws_connect(url, headers=FIGMA)  # what Figma's plugin iframe sends
    await ws.send_json({"type": "hello", "version": version})

    async def pump():
        async for msg in ws:
            m = json.loads(msg.data)
            if m.get("type") == "exec":
                if answer:
                    await ws.send_json({"type": "result", "id": m["id"], "text": "", "value": plugin_reply(m["code"])})
            elif m.get("type") != "stats":
                await inbox.put(m)

    return ws, asyncio.create_task(pump())


async def expect(inbox, pred, timeout=15):
    while True:
        m = await asyncio.wait_for(inbox.get(), timeout)
        if pred(m):
            return m


async def main():
    tmp = Path(tempfile.mkdtemp(prefix="mistok-test-"))
    bridge.TMP, bridge.CHAT_SESSION = tmp, tmp / "chat-session"
    bridge._claude_limits = lambda: None          # no network in tests
    bridge._freepik_key = lambda: None
    fake = tmp / "claude"
    fake.write_text(FAKE_CLAUDE)
    fake.chmod(0o755)
    os.environ["MISTOK_CLAUDE"] = str(fake)

    server = TestServer(bridge.build_app(), host="127.0.0.1")
    await server.start_server()
    base = f"http://127.0.0.1:{server.port}"
    reply = lambda kind: (lambda m: m.get("type") == "chatreply" and m.get("task") == kind)  # noqa: E731
    async with ClientSession() as http:
        r = await http.post(base + "/exec", json={"code": "return 1"})
        assert r.status == 503, "no plugin → 503"
        r = await http.post(base + "/exec", json={"code": "return 1"}, headers={"Origin": "https://evil.example"})
        assert r.status == 403, "browser Origin → 403"
        r = await http.get(base + "/status", headers={"Host": "evil.example"})
        assert r.status == 403, "foreign Host (DNS rebinding) → 403"
        for hdrs in ({"Origin": "https://evil.example"},                              # a web page
                     {"Origin": "null", "User-Agent": "Mozilla/5.0 Chrome/148.0"}):   # its sandboxed iframe
            try:
                await http.ws_connect(base + "/plugin", headers=hdrs)
                raise AssertionError(f"browser WebSocket accepted: {hdrs}")
            except WSServerHandshakeError as e:
                assert e.status == 403, e

        inbox = asyncio.Queue()
        ws, _ = await fake_plugin(http, base + "/plugin", inbox)
        second = await http.ws_connect(base + "/plugin")
        assert "already connected" in (await second.receive_json())["text"]

        r = await http.post(base + "/exec", json={"code": "return 1+1"})
        body = await r.json()
        assert r.status == 200 and body["value"] == 2, body

        await ws.send_json({"type": "spellrequest", "texts": [{"id": "1:5", "text": "Recieve teh license"}]})
        m = await expect(inbox, reply("spell"))
        assert "1 of 1 fixes" in m["text"], m

        await ws.send_json({"type": "chat", "text": "hello"})
        assert (await expect(inbox, reply("chat")))["text"] == "echo: hello"
        sid = bridge.CHAT_SESSION.read_text()
        await ws.send_json({"type": "chat", "text": "again"})     # --resume the same conversation
        assert (await expect(inbox, reply("chat")))["text"] == "echo: again"
        assert bridge.CHAT_SESSION.read_text() == sid
        bridge.CHAT_SESSION.write_text("00000000-0000-4000-8000-000000000000")   # transcript gone
        await ws.send_json({"type": "chat", "text": "fresh"})
        assert (await expect(inbox, reply("chat")))["text"] == "echo: fresh"
        await ws.send_json({"type": "chatreset"})
        await asyncio.sleep(0.2)
        assert not bridge.CHAT_SESSION.exists()

        await ws.send_json({"type": "alplanrequest", "request": {"frames": [{"id": "1:3", "children": []}]}})
        assert "rowx2" in (await expect(inbox, reply("autolayout")))["text"]

        for msg_type, kind in (("redesignrequest", "redesign"), ("protorequest", "prototype")):
            await ws.send_json({"type": msg_type, "request": {"frame": {"id": "1:2", "name": "Hero"}}})
            await expect(inbox, lambda m: m.get("type") == "chatstatus" and "Bash" in m.get("text", ""))
            m = await expect(inbox, reply(kind))
            assert m["node"] == "1:9" and m["img"].startswith("data:image/png") and "[node:" not in m["text"], m
        assert (tmp / "mistok-prototype-request.json").exists()

        await ws.send_json({"type": "imgrequest", "request": {"slots": []}})
        assert "FREEPIK_API_KEY" in (await expect(inbox, reply("imggen")))["text"]

        await ws.send_json({"type": "chat", "text": "slow one"})
        await expect(inbox, lambda m: m.get("type") == "chatstatus" and m.get("task") == "chat")
        await asyncio.sleep(0.5)
        await ws.send_json({"type": "chat", "text": "impatient"})
        assert "still going" in (await expect(inbox, reply("chat")))["text"]
        pid = int((tmp / "claude.pid").read_text())
        await ws.send_json({"type": "kill"})
        assert (await expect(inbox, lambda m: m.get("type") == "killed"))["running"] == ["chat"]
        assert (await expect(inbox, reply("chat")))["text"] == "✕ cancelled"
        await asyncio.sleep(0.3)
        try:
            os.kill(pid, 0)
            raise AssertionError("cancelled claude process still alive")
        except ProcessLookupError:
            pass

        await ws.close()
        await asyncio.sleep(0.2)
        inbox2 = asyncio.Queue()
        ws2, _ = await fake_plugin(http, base + "/plugin", inbox2, version="2.1", answer=False)
        assert "re-run it" in (await expect(inbox2, reply("chat")))["text"]
        slow = asyncio.create_task(http.post(base + "/exec", json={"code": "return 3", "timeout": 30}))
        await asyncio.sleep(0.3)
        await ws2.close()                      # plugin gone mid-request → fails now, not in 30 s
        body = await (await slow).json()
        assert "disconnected" in body["error"], body

    await server.close()
    print("bridge self-test: all checks passed")


if __name__ == "__main__":
    asyncio.run(main())
