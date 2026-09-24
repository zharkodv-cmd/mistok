# Mistok

Drive Figma from your terminal, Claude Code or any HTTP client. A small plugin runs inside Figma Desktop and holds a WebSocket to a local Python bridge: you send Figma Plugin API code over HTTP and get the result back. The plugin panel adds one-click design-system ops and a Claude chat that can work on the open file.

> Mistok («місток», little bridge) is Dmytro Zharko's fork of [Figmosha 2.0](https://github.com/denysosadchyi/figmosha2) by Denys Osadchyi (MIT).

```
mistok CLI / curl / Claude Code        bridge.py (Python)            Figma Desktop
───────────────────────────────        ──────────────────            ─────────────
   POST /exec {code} ─────────────►   HTTP :8787 ──── WS /plugin ──► Mistok plugin
   ◄──── {ok, result, value, logs}                                   └─ Plugin API
```

No browser automation, no clipboard hacks: reads take ~5 ms, mutations ~30 ms, importing a library component ~150 ms.

## Requirements

- **Figma Desktop.** The browser version can't run development plugins.
- **macOS** gets the full setup: the bridge auto-starts via launchd. On Linux the bridge and CLI work, but you start the bridge yourself.
- **Python 3.10+** (`brew install python`). The only dependency is `aiohttp`.
- **[Claude Code](https://claude.com/claude-code)**, logged in. Needed for the panel chat and the Claude-powered buttons; the bridge, the CLI and the other buttons work without it.
- Optional: Playwright for web import (see below).

## Install

The repository is private: you need collaborator access on GitHub, then:

```bash
git clone https://github.com/zharkodv-cmd/mistok.git ~/Code/mistok   # any folder works
cd ~/Code/mistok
./install.sh
```

The installer is safe to re-run. It:

- creates `venv/` and installs the dependencies;
- puts a `mistok` command on your PATH;
- on macOS, registers the bridge as a launchd agent (`com.mistok.bridge`), so it starts at login and restarts if it crashes;
- tells you whether it found Claude Code.

Then, in Figma Desktop:

1. **Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json`. You only do this once.
2. **Plugins → Development → Mistok** starts the plugin. **⌘⌥P** re-runs the last plugin.

To check it works:

```bash
mistok status                              # {"plugin_connected": true, "pending": 0}
mistok "return figma.currentPage.name"     # the open page's name
```

**Optional extras**

- `./install.sh --with-import` adds Playwright and Chromium for web import: paste a URL into the panel chat and the page arrives as editable layers.

**Update:** `git pull && ./install.sh`, then re-run the plugin in Figma. The panel tells you when the running plugin is older than the bridge.
**Uninstall:** `./install.sh --uninstall`, then remove the plugin in Figma (Plugins → Development → Manage plugins).

## CLI

```bash
mistok "return figma.currentPage.children.length"   # shorthand for exec
mistok exec --file script.js                        # or --stdin
mistok tree 1:23 --depth 2          # subtree as indented text
mistok find 1:23 name~Button        # name=X, name~X, type=X, text=X, text~X
mistok text 1:25 "New copy"         # set text; loads fonts, keeps per-range styles
mistok variant 1:30 "Size=Large"    # switch instance variant
mistok clone 1:23 --right --gap 100
mistok rm 1:99
mistok icomp <component-key>        # import a library component, place it, zoom to it
mistok shot 1:23 hero.png --scale 2 # PNG to a file; base64 never reaches your terminal
mistok spec 1:23 --depth 3          # compact design JSON: geometry, auto-layout, var(name) fills, type
mistok vars                         # local variables by collection (aliases as →name)
mistok styles                       # local text styles
mistok focus 1:23                   # scroll the viewport to a node and select it
mistok sel                          # the current selection
mistok img 1:40 photo.jpg           # image fill from a local file (downscaled to Figma's 4096 px)
mistok import https://example.com   # web page → layers (needs --with-import)
```

`spec`, `vars`, `styles` and `sel` print compact single-line JSON, which keeps token counts low for AI agents. You can also skip the CLI and use plain HTTP:

```bash
curl -s localhost:8787/exec -H 'Content-Type: application/json' -d '{"code":"return 1+1"}'
```

### How code runs

```js
new Function("figma", "print", "h", `return (async () => { <YOUR CODE> })();`)(figma, print, HELPERS)
```

- `await` works everywhere, and whatever you `return` comes back as `result` (text) and `value` (JSON).
- `print(...)` lines come back in `logs`.
- Every exec is one undo step in Figma.
- When an error matches a known pattern, the response adds a `hint` with the fix (frozen `fills`, unloaded fonts, missing manifest permission, variant typos, …).

### Helpers (`h.*` in every exec)

| Helper | Use |
|---|---|
| `await h.bF(node, idx, varOrId)` / `h.bS(…)` | Bind a fill / stroke paint to a variable |
| `await h.bN(node, prop, varOrId)` | Bind a numeric prop (radius, padding, gap, size…) |
| `h.findByName(root, name)` / `h.findAllByName(root, name)` | Find descendants by exact name |
| `h.dumpTree(node, {maxDepth, showSize, showText})` | Indented tree text |
| `await h.withFonts(root, fn)` | Load every font in a subtree, then run `fn` |
| `await h.setText(node, text)` | Set a single-font text with its font loaded |
| `await h.replaceText(node, text)` | Change a text by rewriting only the differing span; mixed fonts and per-range styles survive |
| `h.cloneNext(node, {direction, gap, name})` | Clone and place next to the original |
| `await h.variant(inst, props)` / `h.variantsOf(inst)` | Set variant props / list the set's variants |
| `await h.spec(node, {maxDepth})` | The compact design spec behind `mistok spec` |
| `await h.varsDump()` / `h.stylesDump()` | Variables / text styles, as `mistok vars` / `styles` |
| `await h.op(kind, ids?, params?)` | Run a panel op (`lint`, `contrast`, `clean`, `varscolor`, `grid`…) from a script |
| `await h.node(id)`, `h.var_(id)`, `h.importComp(key)`, `h.importVar(key)` | Async shortcuts |

## The plugin panel

From top to bottom:

- Claude plan limits: session, weekly and per-model bars, each with its reset time; you get a Figma notice past 80%.
- The selected node's id, with buttons to copy it, copy an "implement this design" prompt, and take a PNG @2x shot (saved to `~/Desktop/mistok-shots/` and put on the clipboard).
- The op buttons below. Every op is one ⌘Z; its report goes to `/tmp/mistok-ops.log`.

| Button | What it does |
|---|---|
| Clean | Groups nearby layers into named folders, names default layers by content (bg / image / item / icon…), ungroups default groups, rounds to whole px. Instance internals and auto-layout sizing stay intact. |
| Spacing | Auto-layout gaps and paddings → nearest spacing variable |
| Colors | Solid fills/strokes and font size / line height → nearest variable, respecting variable scopes. Hidden (unscoped) primitives are never bound. |
| Styles | Text layers → matching local text styles |
| Layout | Free-placed layers → auto-layout. Claude plans the structure; gaps and paddings are measured from the real geometry. |
| Mobile | A 375 px mobile clone next to the frame, with reflowed auto-layouts, tighter paddings and smaller type |
| Section | Wraps the selection in a Section and lays it out (pad / gap / cols) |
| Grid | Snaps children to the frame's column grid (x and width) |
| Reuse | Fills image slots with the best-matching photos already in the file |
| Photos | Fills image slots with real public-domain photographs from [Openverse](https://openverse.org) (CC0, free for any use, no attribution). No key needed, and nothing marked as AI, render or illustration. Claude turns the texts near each slot into search queries, in any language. Images come at ~1000 px. |
| Spell | Claude proofreads every text and applies the fixes, keeping styles and skipping texts you've edited since |
| Redesign / Prototype / Design | Claude rebuilds the selection next to the original: a redesign after awwwards references, a minimal b/w prototype, or a 1:1 editable recreation of a screenshot, styled with the file's own variables and text styles. It streams progress and shows a preview with a *remove result* button. |
| Lint / Contrast | Read-only audits (design-system drift, WCAG AA). The report lands next to the selection. |

- **Chat** with Claude Code about the open file. Its conversation carries over between messages; `/new` starts a fresh one. A URL on its own imports that web page. ✦ / ↯ pick the model and effort for the chat and the Claude buttons.
- **✕** cancels running background work, **↶** undoes, **–** collapses the panel to a pill.

## Using it from Claude Code

To route a project's Figma work through Mistok instead of the Figma MCP, copy `rule-template.md` into the project as `.claude/rules/mistok.md`. Per-file design notes can live in `projects/<figma-file-name>.md` in this repo; that folder is git-ignored, so the notes stay local.

## Security

- The bridge listens on `127.0.0.1` only. It refuses requests carrying a browser `Origin` or a foreign `Host`, so a web page can't drive it.
- `/exec` runs any JS you send in the open Figma file. Anything that can reach localhost:8787 from your machine has that power.
- The chat and the Redesign / Prototype / Design buttons run Claude Code with `--dangerously-skip-permissions`, so it can use the `mistok` CLI unattended. Use them on files you trust: text inside a design becomes part of the prompt. Spell, Layout and photo search run Claude with no tools at all.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connection refused` | Start the bridge. On macOS: `launchctl kickstart -k gui/$(id -u)/com.mistok.bridge`, or re-run `./install.sh`. Elsewhere: `./start-bridge.sh`. |
| `plugin not connected` (503) | Run the plugin in Figma (⌘⌥P). It's bound to the open file, so re-run it after switching files. |
| Panel shows `retrying…` | The bridge is down or restarting. The plugin reconnects within 2 s. |
| 504 timeout | The code never resolved. Close and re-run the plugin; pass `--timeout` for legitimately long ops. |
| `claude CLI not found` in the panel | Install Claude Code, then re-run `./install.sh` so launchd learns where it is. |
| `permission not specified in manifest` | Add the permission to `plugin/manifest.json` and re-import the plugin. |
| Figma "Unable to establish connection…" on other pages | `await figma.loadAllPagesAsync()` first. |

Bridge log: `/tmp/mistok-bridge.log`. Self-test (a fake plugin and a fake Claude drive the real bridge): `./venv/bin/python tests/test_bridge.py`.

## Layout

```
bridge.py          HTTP/WS bridge + panel jobs (headless Claude, web import, Openverse photos) + limit bars
mistok             CLI client
webimport.py       web page → Figma layers (Playwright)
install.sh         install / update / uninstall (launchd on macOS)
start-bridge.sh    tmux runner for Linux
plugin/            manifest.json, code.js (sandbox: exec, h.* helpers, ops), ui.html (panel)
headless/CLAUDE.md lean context for the Redesign / Prototype / Design sessions
rule-template.md   drop-in .claude/rules/mistok.md for your projects
tests/             bridge self-test
CLAUDE.md          instructions for Claude sessions in this repo (the panel chat runs here)
```

Adding a CLI command means a `cmd_<name>` in `mistok` plus its subparser and a `dispatch` entry. Add helpers to `HELPERS` in `plugin/code.js` (the plugin picks them up on its next run), and error hints to `ERROR_HINTS` in `bridge.py`.

## License

MIT. See [LICENSE](LICENSE).
