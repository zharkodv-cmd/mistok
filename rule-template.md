# Mistok Bridge — primary Figma channel

> Template: copy this file into a project's `.claude/rules/mistok.md` to route all
> Figma reads through the local Mistok bridge (Figma Plugin API over HTTP) instead
> of the official Figma MCP. Add project-specific notes at the bottom.

## Connection

- Server: `http://localhost:8787`. Health check: `curl -s localhost:8787/status` → `{"plugin_connected": true}`.
- The bridge auto-starts via launchd (`com.mistok.bridge`); force-restart: `launchctl kickstart -k gui/$(id -u)/com.mistok.bridge`. Figma Desktop must be open with **Plugins → Development → Mistok** running (auto-reconnects within 2 s; fastest re-run: ⌘⌥P).
- Execute JS: `mistok "<js>"`. Top-level `await` and `return` work; helpers `h.*` are available (see mistok README).

## Command mapping (instead of Figma MCP tools)

| Need | Use |
|---|---|
| File/page structure | `mistok tree <nodeId> --depth 2` |
| Design context of a node | `mistok spec <nodeId> [--depth N]` — compact JSON: geometry, auto-layout, fills/strokes as hex or `var(name)`, typography, effects, layout `grids`, `IMAGE:<hash>` fills |
| Screenshot | `mistok shot <nodeId> out.png [--scale 2]` — PNG straight to file, no base64 in context |
| Design tokens / variables | `mistok vars` — all local variables by collection, aliases as `→name` |
| Find / edit text / variants / clone | `mistok find | text | variant | clone | rm | icomp` |
| Anything else | `mistok exec "<js>"` (or `--file script.js`) |

## Images: Magnific MCP

When the user asks to fill frames/sections with images — generate via the **Magnific MCP** tools, never stock-style placeholders.

- Read the project's art direction first (`projects/<name>.md` in ~/Code/mistok, project brief, color tokens). The prompt must match it.
- Write specific prompts: subject, composition, lighting, palette (hex from tokens), photography/render style. Never generic "beautiful modern image".
- Forbidden in results: text/watermarks, oversaturated HDR look, generic-stock feel, anatomy artifacts. If the result reads as AI slop — refine the prompt and regenerate; do not insert it.
- Match resolution/aspect to the target node (size known from `spec`). Insert: bytes → `figma.createImage(bytes)` → IMAGE fill, `scaleMode: 'FILL'`.
- For hero/key placements generate 2–3 variants and show the user before mass-filling.

## Cautions

- The bridge operates on the **currently open file** in Figma Desktop. Verify `figma.root.name` before batch reads.
- Export at the resolution you need, don't default to @2x/@3x for everything.
- Write operations (mutations) are possible — do NOT mutate the design file unless the user explicitly asks.
- Per-project design conventions live in `~/Code/mistok/projects/<name>.md` — read before design work, append dated decisions.

## Project-specific

<!-- node IDs, page conventions, token quirks of THIS project go here -->
