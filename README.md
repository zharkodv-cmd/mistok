# Mistok

Drive Figma from your terminal / Claude Code / any HTTP client. A tiny custom plugin sits inside Figma Desktop and holds a WebSocket to a local Python server — you send Figma Plugin API code over HTTP and get the result back.

> Mistok («місток» — little bridge) is Dmytro Zharko's fork of [Figmosha 2.0](https://github.com/denysosadchyi/figmosha2) by Denys Osadchyi (MIT).

No Playwright. No browser automation. No clipboard hacks. No screenshots.

Measured **150–950× faster** than browser-driven approaches: reads ~5 ms, mutations ~30 ms, library component import ~150 ms.

## Why this exists

The Figma Plugin API is the most stable and powerful interface Figma offers. Thousands of plugins depend on it. But typically it's only accessible *inside* Figma's UI — you click "Run plugin", code executes, results appear in a panel.

Mistok keeps a plugin permanently open in Figma and exposes its Plugin API through a local network socket. You write code in your editor / Claude / a script, it runs inside Figma, and the result comes back to you.

```
PowerShell / curl / Claude Code     bridge.py (Python)         Figma Desktop
───────────────────────────         ─────────────────          ─────────────
                                                               ┌────────────┐
   POST /exec  ──────────────►   HTTP server                   │ open file  │
                                    │                          │            │
                                    ▼                          │ ┌────────┐ │
                                 WS server  ──ws://localhost── ┤ │Mistok│ │
                                                               │ │ Bridge │ │
                                    ▲                          │ │(plugin)│ │
                                    │                          │ └───┬────┘ │
   ◄──── HTTP response                                         │     │      │
        {ok, result, value, logs, elapsed_ms, hint?}            │     ▼      │
                                                               │ Plugin API │
                                                               └────────────┘
```

## Highlights

- **One Python file** server + **one Python file** CLI. No npm. No frameworks.
- **Custom Figma plugin** (JS + HTML). Imported in dev mode — no publishing.
- **17 helpers** baked into the plugin runtime as `h.*` so scripts stay short and safe (`h.bF`, `h.setText`, `h.withFonts`, `h.spec`, `h.varsDump`, `h.variantsOf`, …).
- **11 high-level CLI subcommands** for common ops (`tree`, `find`, `text`, `variant`, `clone`, `rm`, `icomp`, `shot`, `spec`, `vars`, `sel`).
- **Plugin panel with live telemetry**: selection row (⧉ copy id, 📷 PNG @2x → `~/Desktop/mistok-shots/` + system clipboard), Claude subscription limit bars, today's usage stats, color-coded log with mutation highlighting.
- **Smart error hints** in responses — when a script fails with a known-pattern error, the response includes a `hint` field telling you how to fix it.
- **Works while Figma is minimized.** WebSocket stays alive; JavaScript keeps executing in the background.
- **Auto-reconnect** in the plugin UI — restart the server, plugin reconnects within 2 s.

## Requirements

- **Figma Desktop** (Stable or Beta) — [download](https://www.figma.com/downloads/). The browser version cannot import local development plugins.
- **Python 3.10+** — for the bridge server and CLI client. Stdlib + a single dependency (`aiohttp`).
- **OS**: macOS, Windows (native or WSL2), or Linux.

## Install

### 1. Clone the repo

```bash
# Mistok lives locally (fork of figmosha2; upstream lacks the Mistok additions).
# If you've pushed your own remote, clone that; the original base is:
git clone https://github.com/denysosadchyi/figmosha2.git mistok
cd mistok
```

### 2. Set up Python

**macOS / Linux:**

```bash
python3 -m venv venv
./venv/bin/pip install aiohttp
```

**Windows (native PowerShell):**

```powershell
python -m venv venv
.\venv\Scripts\pip install aiohttp
```

**Windows + WSL2** (recommended if you already use WSL): same as macOS/Linux inside WSL. WSL2 auto-forwards `localhost` ports to the Windows host, so Figma Desktop (running on Windows native) can reach the bridge running inside WSL transparently.

### 3. Import the plugin into Figma

1. Open **Figma Desktop**
2. Open any file (or create a new one)
3. Top menu → **Plugins** → **Development** → **Import plugin from manifest…**
4. Select `plugin/manifest.json` from this repo

Figma registers "Mistok" under `Plugins → Development`. You only do this once.

**WSL2 note**: if your repo lives in WSL but Figma runs on Windows native, copy `plugin/` to a Windows-accessible path first:

```bash
mkdir -p /mnt/c/Users/$WIN_USER/mistok-plugin
cp plugin/* /mnt/c/Users/$WIN_USER/mistok-plugin/
```

Then import `C:\Users\<your-name>\mistok-plugin\manifest.json` in Figma.

### 4. Start the bridge

**macOS (recommended)** — launchd agent, auto-starts at login and restarts on crash:

```bash
# create ~/Library/LaunchAgents/com.mistok.bridge.plist pointing at venv/bin/python bridge.py, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mistok.bridge.plist
curl -s localhost:8787/status                              # health check
launchctl kickstart -k gui/$(id -u)/com.mistok.bridge      # force-restart
```

**Linux / WSL** — tmux fallback:

```bash
bash start-bridge.sh          # detached tmux session "mistok-bridge"
# OR: just run it in a terminal you keep open
./venv/bin/python bridge.py
```

**Windows native** (no tmux):

```powershell
.\venv\Scripts\python bridge.py
```

The server listens on `127.0.0.1:8787`. Output:

```
[bridge] listening on http://127.0.0.1:8787
[bridge] plugin should connect to ws://localhost:8787/plugin
```

### 5. Run the plugin in Figma

In Figma Desktop: **Plugins** → **Development** → **Mistok** → **Run**.

A small window appears: **bridge: connected** (green). In the server terminal you'll see `[plugin] connected from 127.0.0.1`. You're live.

### 6. Smoke test

In a second terminal:

```bash
./venv/bin/python mistok status
# → {"plugin_connected": true, "pending": 0}

./venv/bin/python mistok "return figma.currentPage.name"
# → "Page 1"

./venv/bin/python mistok "const r = figma.createRectangle(); r.x = 100; r.y = 100; r.resize(200, 100); r.name = 'smoketest'; return r.id"
# → "1:23"  (and a rectangle appears in Figma)
```

If all three work — you're done.

## Daily use

### Start a session

```bash
# macOS: nothing to start — launchd keeps the bridge alive (survives reboot).
# Linux/WSL: bash start-bridge.sh
# In Figma: Plugins → Development → Mistok → Run (fastest re-run: ⌘⌥P)
```

On macOS the launchd agent survives OS reboot. The tmux fallback survives SSH disconnects but **not** reboot/WSL shutdown — restart it after either.

### Send code

```bash
# Inline JS
python mistok "return figma.currentPage.children.length"

# From a file
python mistok exec --file my-script.js

# From stdin
cat my-script.js | python mistok exec --stdin

# Plain HTTP (no Python needed)
curl -s http://localhost:8787/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"return 1+1"}'
```

### High-level CLI commands

When the operation fits one of these, use the dedicated subcommand — much less typing and less risk of escape bugs:

```bash
python mistok tree 1:23 --depth 2          # dump subtree
python mistok find 1:23 name=Button         # find by exact name
python mistok find 1:23 name~Btn            # substring name match
python mistok find 1:23 type=INSTANCE       # filter by type
python mistok find 1:23 text~hello          # find TEXT containing "hello"
python mistok text 1:25 "new content"       # set TEXT chars (autoloads fonts)
python mistok variant 1:30 "Property 1=Default"
python mistok clone 1:23 --right --gap 100  # clone adjacent
python mistok rm 1:99                       # delete a node
python mistok icomp <component-key>         # import library component, place + zoom
python mistok shot 1:23 hero.png --scale 2  # export node as PNG to a local file
python mistok spec 1:23 --depth 3           # compact design spec: geometry, auto-layout,
                                                 #   fills/strokes as hex or var(name), typography
python mistok vars                          # all local variables by collection (aliases as →name)
python mistok sel                           # current selection in Figma (ids, names, sizes)
python mistok status                        # bridge + plugin connection state
```

`spec`, `vars`, and `sel` print **compact single-line JSON** — designed for AI agents that pay per token. `shot` decodes the PNG locally, so no base64 ever hits your terminal.

## Code conventions

The plugin wraps your code as:

```js
new Function("figma", "print", "h", `return (async () => { <YOUR CODE> })();`)(figma, print, HELPERS)
```

- `await` works everywhere. Body is wrapped in an async IIFE.
- Whatever you `return` becomes the HTTP response's `result` (string) and `value` (raw JSON-serializable form).
- `print(...)` collects lines into the `logs` array — also streamed to the plugin UI for live debugging.

### Helpers (available as `h.*` in every exec)

| Helper | Use |
|---|---|
| `await h.bF(node, idx, varOrId)` | Bind fill paint at `idx` to variable (handles frozen-array dance) |
| `await h.bS(node, idx, varOrId)` | Bind stroke paint to variable |
| `await h.bN(node, prop, varOrId)` | Bind numeric prop (radius, padding, size, itemSpacing, …) |
| `h.findByName(root, name)` | First descendant with exact name |
| `h.findAllByName(root, name)` | All descendants with exact name |
| `h.dumpTree(node, {maxDepth, showSize, showText})` | Indented tree string |
| `await h.withFonts(root, asyncFn)` | Auto-loads every unique font in the subtree, then runs your callback |
| `await h.setText(node, text)` | Sets `node.characters` with auto font load (single-font nodes only) |
| `h.cloneNext(node, {direction, gap, name})` | Clone + place adjacent (`right`/`left`/`up`/`down`) |
| `await h.variant(instance, props)` | Wrapper around `instance.setProperties(...)` |
| `await h.variantsOf(instance)` | `{current, groups, all}` of the component set |
| `await h.node(id)` | Shorthand for `figma.getNodeByIdAsync(id)` |
| `await h.var_(idOrKey)` | Resolve variable from id or instance |
| `await h.importComp(key)` | `figma.importComponentByKeyAsync(key)` |
| `await h.importVar(key)` | `figma.variables.importVariableByKeyAsync(key)` |
| `await h.spec(node, {maxDepth})` | Compact design spec of subtree — geometry, layout, fills as hex/`var(name)`, typography |
| `await h.varsDump()` | All local variables grouped by collection, aliases resolved to `→name` |

Compared to inlined boilerplate, helpers reduce a typical script by ~60–70% and avoid common gotchas (frozen `node.fills`, missing `loadFontAsync`, deprecated sync `getVariableById`).

### Error hints

When a script fails with a recognized pattern, the response includes a `hint` field. The CLI prints it for you:

```
$ mistok "node.characters = 'x'"
mistok: Cannot write to node with unloaded font "Inter Regular"...
   hint: use h.setText(node, text) or h.withFonts(root, fn) — they autoload fonts
```

Currently hints cover: fills/strokes variable binding, frozen arrays, missing manifest permissions, unloaded fonts, appendChild order, invalid variant values, and a few more.

## Limits / gotchas

- Plugin is bound to the **currently open Figma file**. Switching files closes the plugin — re-Run it in the new file.
- Only **one plugin instance** connects to the server at a time. Opening the plugin in a second Figma window is rejected.
- **Figma sync errors** ("Unable to establish connection to Figma after 10 seconds") sometimes appear when fetching nodes from non-current pages. If you need cross-page access: `await figma.loadAllPagesAsync()` first.
- Bridge binds to `127.0.0.1` by default. For LAN access: `python bridge.py --host 0.0.0.0` (not recommended — anyone on your LAN can then run arbitrary code in your Figma).
- Manifest changes (new permissions, etc.) require **re-importing** the plugin in Figma. `code.js` and `ui.html` changes are picked up on next Run.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` from CLI | Server not running | macOS: `launchctl kickstart -k gui/$(id -u)/com.mistok.bridge`; other OS: `bash start-bridge.sh` |
| `plugin not connected` (503) | Plugin window closed | Plugins → Development → Mistok → Run |
| Plugin says `disconnected, retrying…` | Server is down or restarting | Start it; plugin auto-reconnects within 2 s |
| 504 timeout | Code threw silently or `await` never resolved | Close the plugin (X), Run again. Increase `--timeout` for legitimately long ops |
| `permission not specified in manifest` | API needs a permission not declared in `manifest.json` | Add to `permissions` array, sync to Windows path if applicable, **re-import** plugin |
| `Cannot write to node with unloaded font` | Need to load fonts first | Use `await h.setText(...)` or wrap edits in `h.withFonts(root, fn)` |
| `Cannot assign to read only property` | `node.fills` is frozen | Use `await h.bF(node, idx, varId)` or copy: `JSON.parse(JSON.stringify(node.fills))` |
| `pip install aiohttp` fails on Linux | Python externally-managed environment (PEP 668) | Use the venv approach (always preferred) or `pip install --user --break-system-packages aiohttp` |
| Tmux not installed (Windows native) | `start-bridge.sh` won't work | Run `python bridge.py` in a regular terminal instead |

## Project layout

```
bridge.py              HTTP/WS server + Claude usage/limits telemetry + shot file-save
mistok                 CLI client (13 subcommands)
start-bridge.sh        tmux fallback runner (macOS uses launchd: com.mistok.bridge)
rule-template.md       Template rule for wiring Mistok into a Claude Code project
plugin/
  manifest.json        Permissions + allowed origins
  code.js              Plugin sandbox: exec + 17 h.* helpers + selection/export
  ui.html              WS client, selection row (⧉/📷), limit bars, stats, colored log
projects/              Per-project design conventions (<name>.md)
archive/               Retired one-off scripts and data snapshots
CLAUDE.md              Conventions for Claude Code sessions driving Mistok
README.md              This file
```

### Plugin panel

The plugin window shows, top to bottom: Claude subscription limit bars (session / weekly, red as you approach the cap, `figma.notify` warning past 80%), the current selection (node id with **⧉** copy and **📷** export — PNG @2x saved to `~/Desktop/mistok-shots/` *and* placed on the system clipboard for instant ⌘V), today's Claude usage (session duration, project, messages, tokens — pushed by the bridge every 60 s from `~/.claude` transcripts), and a color-coded log where write-looking code is tagged `[exec✎]`. The `–` button collapses everything to a tiny status pill.

## Contributing / extending

The plugin runtime is just `new Function("figma", "print", "h", body)`. Add helpers to `HELPERS` in `plugin/code.js`, sync the file to your plugin path, and they're available in your next `exec`.

To add a new CLI subcommand:
1. Add a `cmd_<name>(args)` function in `mistok` that builds JS via `json.dumps`-escaped templates
2. Add a subparser in `build_parser()`
3. Register in the `dispatch` map

To add an error hint:
1. Append a `(needle, hint)` tuple to `ERROR_HINTS` in `bridge.py`
2. Restart the bridge

## License

MIT
