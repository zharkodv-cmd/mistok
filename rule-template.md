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
| What the user selected in Figma («цей фрейм», «ця секція») | `mistok sel` — ids/names/sizes of the current selection |
| Find / edit text / variants / clone | `mistok find | text | variant | clone | rm | icomp` |
| Anything else | `mistok exec "<js>"` (or `--file script.js`) |

## Images: Magnific MCP

When the user asks to fill frames/sections with images — search & download READY premium stock photos via the **Magnific MCP** tools (do NOT AI-generate unless explicitly asked).

- Read the project's art direction first (`projects/<name>.md` in ~/Code/mistok, project brief, color tokens). The prompt must match it.
- Write specific prompts: subject, composition, lighting, palette (hex from tokens), photography/render style. Never generic "beautiful modern image".
- Forbidden in results: text/watermarks, oversaturated HDR look, generic-stock feel, anatomy artifacts. If a result looks like AI slop or a generic stock cliché — pick another photo; do not insert it.
- Match resolution/aspect to the target node (size known from `spec`). Insert: bytes → `figma.createImage(bytes)` → IMAGE fill, `scaleMode: 'FILL'`.
- For hero/key placements generate 2–3 variants and show the user before mass-filling.
- **Plugin ✨ button** writes a request to `/tmp/mistok-image-request.json` (frame, slots with ids/sizes/nearby texts). When the user says «встав картинки» — read it, find & download matching premium photos per the quality bar above, insert each via `mistok img <slotId> file.png`, then delete the request file.

## Cautions

- The bridge operates on the **currently open file** in Figma Desktop. Verify `figma.root.name` before batch reads.
- Export at the resolution you need, don't default to @2x/@3x for everything.
- Write operations (mutations) are possible — do NOT mutate the design file unless the user explicitly asks.
- Per-project design conventions live in `~/Code/mistok/projects/<name>.md` — read before design work, append dated decisions.

## Project-specific

<!-- node IDs, page conventions, token quirks of THIS project go here -->

## Section redesign (plugin ⟳ button)

The button writes `/tmp/mistok-redesign-request.json` (section spec + instruction). When the user says «редизайнь секцію»: read it; browse awwwards.com Sites of the Day / Honorable Mentions via Playwright; pick 2–3 sections similar in meaning and capture reference screenshots; redraw the section NEXT TO the original using the file's variables (respect scopes), text styles and existing assets, 1–2 variants; references are inspiration, not a copy; delete the request file when done.

## Прототип (кнопка ▭ у плагіні)

Кнопка пише запит у `/tmp/mistok-prototype-request.json` (spec джерела + інструкція). Коли користувач каже «зроби прототип»: прочитай запит; якщо джерело — бітмап (фрейм з одним IMAGE-прямокутником) — `mistok shot` і прочитай візуально; збери поруч із джерелом сучасний мінімалістичний прототип: Inter (Regular/Medium/Semi Bold — саме «Semi Bold» з пробілом), чорно-біло-сірий (#111/#6B6B6B/#F0F0F0/#E5E5E5), повний auto-layout, ВСІ тексти і логіка джерела. Після виконання видали файл запиту.
