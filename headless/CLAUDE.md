# Mistok headless protocols (lean context)

You drive Figma through the `mistok` CLI (on PATH). Bridge: localhost:8787, operates on the currently open file.

## CLI cheatsheet
```
mistok spec <id> [--depth N]     # compact design JSON (geometry, fills as hex/var(name), typography, grids)
mistok shot <id> out.png [--scale 2]
mistok vars                      # all variables by collection (aliases resolved, colors hex)
mistok tree <id> --depth 2
mistok img <id> file.png         # local image → IMAGE fill (auto-downscales to 4096px)
mistok exec "<js>" | exec --file f.js   # arbitrary Plugin API JS; `await`/`return` work; helpers h.*
```

## exec rules (critical)
- Auto-layout order: parent.appendChild(node) FIRST, then layoutMode, then resize/sizing/spacing.
- `node.fills` is frozen — copy via JSON.parse(JSON.stringify(...)) or use h.bF(node, idx, varId).
- Text: await figma.loadFontAsync(node.fontName) before setting characters (or h.setText). Inter styles: "Regular", "Medium", "Semi Bold", "Bold".
- Bind color: figma.variables.setBoundVariableForPaint(paint, "color", variable). Numbers: node.setBoundVariable(prop, variable).
- Batch work into AT MOST 3 exec calls (build → bind → fix). figma.commitUndo() at the end of each.

## Strict styling (all protocols)
ONLY this file's design system: its color variables (respect scopes: TEXT_FILL/FRAME_FILL/SHAPE_FILL/STROKE_COLOR/GAP/FONT_SIZE/LINE_HEIGHT), its text styles, its existing assets. Never invent hex or ad-hoc fonts — pick the closest existing token. Get them via `mistok vars` and `figma.getLocalTextStylesAsync()`.

## Placement (all protocols)
Result ALWAYS next to the source: same parent/page, x = source.x + source.width + 100, y = source.y. Fetch source coords/parent via mistok exec by the id from the request file.

## Protocols

### recreate the design → /tmp/mistok-design-request.json
Source is a screenshot. `mistok shot` it (scale 1–2), read carefully. Rebuild 1:1 editable layers: exact positions/sizes; colors ONLY file variables (closest, scoped); typography ONLY file text styles; real TEXT nodes; image areas as placeholders. Then shot the result, compare side-by-side, fix visible deltas once.

### redesign the section → /tmp/mistok-redesign-request.json
Works for any selection (bitmap source: shot + read visually first). Find 2–3 awwwards-grade references similar in meaning (use knowledge; browsing optional via ~/Code/mistok/venv playwright). Redraw next to the original: composition/spacing/scale from the REFERENCE by eye (never copy source paddings); styling strictly from the file. Bold, crafted, no AI slop. Then shot the result and fix weak spots once.

### build the prototype → /tmp/mistok-prototype-request.json
Modern minimalist prototype: Inter (Regular/Medium/"Semi Bold"), black/white/gray (#111/#6B6B6B/#F0F0F0/#E5E5E5), full auto-layout, ALL texts and logic of the source (bitmap → shot + read visually).

## Finish
Delete the request file. Reply with ONE line: what was built, frame name, key counts. No process narration.
