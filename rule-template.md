# Mistok Bridge — primary Figma channel

> Template: copy this file into a project's `.claude/rules/mistok.md` to route all
> Figma reads through the local Mistok bridge (Figma Plugin API over HTTP) instead
> of the official Figma MCP. Add project-specific notes at the bottom.

## Connection

- Server: `http://localhost:8787`. Health check: `curl -s localhost:8787/status` → `{"plugin_connected": true}`.
- The bridge auto-starts via launchd (`com.mistok.bridge`, set up by the mistok repo's `install.sh`); force-restart: `launchctl kickstart -k gui/$(id -u)/com.mistok.bridge`. Figma Desktop must be open with **Plugins → Development → Mistok** running (auto-reconnects within 2 s; fastest re-run: ⌘⌥P).
- Execute JS: `mistok "<js>"`. Top-level `await` and `return` work; helpers `h.*` are available (see mistok README).

## Command mapping (instead of Figma MCP tools)

| Need | Use |
|---|---|
| File/page structure | `mistok tree <nodeId> --depth 2` |
| Design context of a node | `mistok spec <nodeId> [--depth N]` — compact JSON: geometry, auto-layout, fills/strokes as hex or `var(name)`, typography, effects, layout `grids`, `IMAGE:<hash>` fills |
| Screenshot | `mistok shot <nodeId> out.png [--scale 2]` — PNG straight to file, no base64 in context |
| Design tokens / variables | `mistok vars` — all local variables by collection, aliases as `→name` |
| Text styles | `mistok styles` — all local text styles (name, font, size, lineH) |
| Show a node to the user | `mistok focus <nodeId>` — scroll viewport + select |
| What the user selected in Figma («цей фрейм», «ця секція») | `mistok sel` — ids/names/sizes of the current selection |
| Find / edit text / variants / clone | `mistok find | text | variant | clone | rm | icomp` |
| Anything else | `mistok exec "<js>"` (or `--file script.js`) |

## Images: Magnific MCP

When the user asks to fill frames/sections with images — search & download READY premium stock photos via the **Magnific MCP** tools (do NOT AI-generate unless explicitly asked).

- Read the project's art direction first (`projects/<name>.md` in the mistok repo, project brief, color tokens). The prompt must match it.
- Write specific prompts: subject, composition, lighting, palette (hex from tokens), photography/render style. Never generic "beautiful modern image".
- Forbidden in results: text/watermarks, oversaturated HDR look, generic-stock feel, anatomy artifacts. If a result looks like AI slop or a generic stock cliché — pick another photo; do not insert it.
- Match resolution/aspect to the target node (size known from `spec`). Insert: bytes → `figma.createImage(bytes)` → IMAGE fill, `scaleMode: 'FILL'`.
- For hero/key placements generate 2–3 variants and show the user before mass-filling.
- **Plugin ✨ Photos button** fills slots by itself when the bridge has a `FREEPIK_API_KEY`; otherwise it writes a request to `/tmp/mistok-image-request.json` (frame, slots with ids/sizes/nearby texts). When the user says «встав картинки» — read it, find & download matching premium photos per the quality bar above, insert each via `mistok img <slotId> file.png`, then delete the request file.

## Cautions

- The bridge operates on the **currently open file** in Figma Desktop. Verify `figma.root.name` before batch reads.
- Export at the resolution you need, don't default to @2x/@3x for everything.
- Write operations (mutations) are possible — do NOT mutate the design file unless the user explicitly asks.
- Per-project design conventions live in the mistok repo's `projects/<name>.md` (local, git-ignored) — read before design work, append dated decisions.

## Project-specific

<!-- node IDs, page conventions, token quirks of THIS project go here -->

## Section redesign (plugin ⟳ button)

The panel buttons ⟳ ▭ ◆ run these protocols by themselves in a background Claude session (rules: `headless/CLAUDE.md` in the mistok repo). The steps below are for when the user asks YOU to do it.

The button writes `/tmp/mistok-redesign-request.json` (section spec + instruction). When the user says «редизайнь секцію»: read it; browse awwwards.com Sites of the Day / Honorable Mentions via Playwright; pick 2–3 sections similar in meaning and capture reference screenshots; redraw the section NEXT TO the original using the file's variables (respect scopes), text styles and existing assets, 1–2 variants; references are inspiration, not a copy. Placement — ALWAYS next to the source: same parent/page, `x = source.x + source.width + 100`, `y = source.y` (fetch coords and parent via `mistok exec` using the request's frame id). Delete the request file when done.

## Prototype (plugin ▭ button)

Writes `/tmp/mistok-prototype-request.json` (source spec + instruction). On «build the prototype» / «зроби прототип»: read it; if the source is a bitmap (a frame with one IMAGE rectangle) — `mistok shot` it and read it visually; build NEXT TO the source a modern minimalist prototype: Inter (Regular / Medium / "Semi Bold" — with the space), black/white/gray (#111/#6B6B6B/#F0F0F0/#E5E5E5), full auto-layout, ALL texts and logic of the source. Delete the request file when done.

## Recreate (◆ Design button)

Writes `/tmp/mistok-design-request.json`. On «recreate the design»: the source is a screenshot (frame with an IMAGE fill). mistok shot it at scale 1–2 and read carefully; rebuild NEXT TO it as 1:1 editable layers: exact geometry; colors ONLY from the file's color variables (closest token, scopes), typography ONLY from the file's text styles; real TEXT nodes, fills/borders/radii/shadows as seen. Finish with a side-by-side shot comparison and fix deltas. Placement — ALWAYS next to the source: same parent/page, `x = source.x + source.width + 100`, `y = source.y` (fetch coords and parent via `mistok exec` using the request's frame id). Delete the request file.

## Redesign — addendum

Applies to ANY selection (group, text block, section, page frame). The source may be a bitmap screenshot/sketch (frame with one IMAGE rectangle) — mistok shot it and read visually first. Spacing/scale/composition come from the REFERENCE by eye (never copy the source paddings); only colors/type/assets from our file. Styling is STRICTLY the file's system: ONLY its color variables (scopes), ONLY its text styles, ONLY existing assets — never invent hex values or ad-hoc fonts; pick the closest existing token when unsure. Finish with impeccable-grade craft.
