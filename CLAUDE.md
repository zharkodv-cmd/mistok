# Figmosha 2.0 — Claude Code instructions

Drive Figma by sending JS code through a local bridge that's connected to a custom plugin running inside Figma Desktop.

**Per-project design conventions live in `projects/<name>.md`.** Before design work in a Figma file, check `projects/` for a matching md (e.g. file "Coast Flight" → `projects/coast-flight.md`) and read it first. Append dated decisions to its "Історія рішень" section as you make them.

## How to send code

```bash
# Preferred — subcommand-style
python figmosha.py exec "return figma.currentPage.name"
python figmosha.py exec --file script.js

# Shorthand (auto-prepends `exec`)
python figmosha.py "return figma.currentPage.name"

# High-level commands (covered below) save tokens for common operations
python figmosha.py text 185:21880 "Привіт"
python figmosha.py variant 185:21883 "Property 1=Default"
python figmosha.py shot 185:21880 out.png --scale 2   # PNG export straight to file — NO base64 in context
python figmosha.py spec 185:21880 --depth 3           # design spec, compact JSON — use INSTEAD of custom extraction JS
python figmosha.py vars                               # all local variables by collection

# Quick HTTP (no Python needed)
curl -s -X POST http://localhost:8787/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"return figma.currentPage.id"}'

# Status
curl -s http://localhost:8787/status   # {"plugin_connected": true/false, "pending": 0}
```

If the bridge isn't running: `bash start-bridge.sh` (runs in tmux `figmosha-bridge`; logs at `/tmp/figmosha-bridge.log`).

If the plugin isn't connected: tell the user — `Plugins → Development → Figmosha Bridge → Run`.

## Helpers (available as `h.*` in every exec)

The plugin runtime exposes a small helper namespace. Use these to keep scripts short:

| Helper | What |
|---|---|
| `await h.bF(node, idx, varOrId)` | Bind fill paint to variable (id or instance) |
| `await h.bS(node, idx, varOrId)` | Bind stroke paint to variable |
| `await h.bN(node, prop, varOrId)` | Bind numeric prop (radius, padding, size...) |
| `h.findByName(root, name)` | First descendant by exact name |
| `h.findAllByName(root, name)` | All descendants by exact name |
| `h.dumpTree(node, {maxDepth, showSize, showText})` | Indented tree string |
| `await h.withFonts(root, asyncFn)` | Loads every unique font in subtree, then runs `asyncFn` |
| `await h.setText(node, text)` | Set TEXT node chars with auto font load |
| `h.cloneNext(node, {direction, gap, name})` | Clone + place adjacent (`right`/`left`/`up`/`down`) |
| `await h.variant(instance, props)` | Wrapper around `instance.setProperties(...)` |
| `await h.variantsOf(instance)` | `{ current, groups, all }` for the component set |
| `await h.node(id)` | Shorthand for `figma.getNodeByIdAsync(id)` |
| `await h.var_(idOrKey)` | Resolve a variable from id or instance |
| `await h.importComp(key)` | `figma.importComponentByKeyAsync(key)` |
| `await h.importVar(key)` | `figma.variables.importVariableByKeyAsync(key)` |
| `await h.spec(node, {maxDepth})` | Compact design spec — geometry, layout, fills as hex/`var(name)`, typography |
| `await h.varsDump()` | Local variables by collection, aliases as `→name`, colors as hex |

**Use them.** Compared to inline boilerplate, helpers save ~70% of the script and avoid common mistakes (frozen `node.fills`, missing `loadFontAsync`, etc.).

### Bad vs good

```js
// Bad — verbose, easy to miss
const f = JSON.parse(JSON.stringify(node.fills));
f[0] = figma.variables.setBoundVariableForPaint(f[0], "color", v);
node.fills = f;

// Good — helper handles freezing + setBoundVariableForPaint
await h.bF(node, 0, v);
```

```js
// Bad — must remember to load fonts first; mixed-font case is silent
await figma.loadFontAsync(node.fontName);
node.characters = "new";

// Good
await h.setText(node, "new");
```

```js
// Bad — manual font collection
const texts = root.findAll(n => n.type === "TEXT");
const fonts = [...new Set(texts.map(t => `${t.fontName.family}|${t.fontName.style}`))];
// ... load each ...

// Good
await h.withFonts(root, async () => {
  // bulk-edit text inside `root` here
});
```

## CLI subcommands (save tokens for common ops)

| Command | Equivalent JS | Use case |
|---|---|---|
| `figmosha tree <id>` | `h.dumpTree(await h.node(id))` | Explore node structure |
| `figmosha find <id> name=Button` | `(await h.node(id)).findAll(n => n.name === "Button")` | Locate by name |
| `figmosha find <id> name~Btn` | `findAll(n => n.name.includes("Btn"))` | Substring name match |
| `figmosha find <id> type=INSTANCE` | `findAll(n => n.type === "INSTANCE")` | Filter by type |
| `figmosha find <id> text~Привіт` | `findAll(n => n.type === "TEXT" && n.characters.includes(...))` | Find by text |
| `figmosha text <id> "новий"` | `await h.setText(n, "новий")` | Edit text safely |
| `figmosha variant <id> "Property 1=Default"` | `await n.setProperties({...})` | Switch variant |
| `figmosha clone <id> --right --gap 100` | `h.cloneNext(n, {direction:'right',gap:100})` | Duplicate adjacent |
| `figmosha rm <id>` | `n.remove()` | Delete |
| `figmosha icomp <key>` | `(await h.importComp(key)).createInstance()` | Pull from library |

Use subcommands when the op fits one of these. Fall back to `exec` for anything else.

## How exec evaluates code

```js
new Function("figma", "print", "h", `return (async () => { <YOUR CODE> })();`)(figma, print, HELPERS)
```

- `return ...` becomes the `result` field of the response (stringified + raw `value` if JSON-serializable).
- `await` works everywhere.
- `print(...)` collects log lines (returned in the `logs` array; also streamed to plugin UI).
- Exceptions → `{ok:false, error, hint?, stack, logs}` with HTTP 500.

The bridge **adds a `hint` field** when it recognizes a common error (fills/strokes binding, frozen array, font not loaded, missing permission, appendChild order, variant typo). Pay attention to it.

## Conventions

### Use async APIs

The plugin runs under dynamic-page documentAccess where lookups are async:

```js
const node = await figma.getNodeByIdAsync(id)        // or: await h.node(id)
const main = await instance.getMainComponentAsync()
const cols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
const comp = await figma.importComponentByKeyAsync(key)  // or: await h.importComp(key)
```

### Auto-layout: order matters

`resize()` / spacing / sizing modes are ignored if set before `layoutMode`:

```js
const f = figma.createFrame()
parent.appendChild(f)            // 1. into tree first
f.layoutMode = "VERTICAL"        // 2. layoutMode
f.resize(400, 100)               // 3. size
f.primaryAxisSizingMode = "AUTO" // 4. sizing
f.itemSpacing = 16               // 5. spacing/padding
f.paddingTop = 24
```

### Two-stage workflow for big builds

For complex builds (component sets with many variants + variable binding): split into Step 1 = build structure with hardcoded RGB; Step 2 = walk nodes by `name` and bind via `h.bF`/`h.bS`/`h.bN`. Verify each step independently.

Name nodes in Step 1 so Step 2 can `h.findByName(root, "...")` them.

### Don't take screenshots for verification

The bridge returns the data you need. Verify by:

```js
return (await h.node("...")).width
return root.findAll(n => n.type === "TEXT").map(t => t.characters)
```

`node.exportAsync({format:"PNG"})` exists if you genuinely need pixels — returns bytes. Don't use it as "is the code working" check.

## When something looks wrong

- **`plugin not connected` (503)**: plugin window closed in Figma. Ask user to Run it again.
- **Timeout (504)**: probably infinite loop or unresolved `await`. Ask user to close & re-run plugin.
- **`teamlibrary permission not specified`** (or similar): manifest needs a new permission. Edit `plugin/manifest.json`, sync to user's Windows copy (`/mnt/c/Users/User/figmosha-plugin/manifest.json` on their WSL), ask user to **re-import** the plugin (Plugins → Development → Manage plugins → remove + Import again).
- **Result looks weird / undefined**: you forgot `return`. The wrapper expects a value.
- **Switch Figma file → plugin disconnects**: plugin is bound to the open file. After switching, ask user to Run plugin again.

The error response includes a `hint` field for common cases — read it before debugging.

## Where things live (macOS, актуально)

Усе локально, ніякого WSL і синхронізації.

- Bridge + плагін: `~/Code/figmosha2/`
- Figma Desktop вантажить плагін **напряму з репозиторію** — `~/Code/figmosha2/plugin/` (перевірено в `~/Library/Application Support/Figma/settings.json`). Правки в `code.js` / `ui.html` підхоплюються після **Run**, копіювати нікуди не треба. Re-Import потрібен лише при зміні `manifest.json`.
- Venv: `~/Code/figmosha2/venv/` (arm64, Python 3.12)
- Log: `/tmp/figmosha-bridge.log`

`tmux` на цій машині немає, тож `start-bridge.sh` не працює як є. Запуск:

```bash
cd ~/Code/figmosha2 && nohup ./venv/bin/python bridge.py > /tmp/figmosha-bridge.log 2>&1 &
```

`nohup` обов'язковий — інакше bridge помирає разом із сесією агента. Перевірка: `curl -s http://localhost:8787/status`.

## UI плагіна

Вікно згортається в компактний бар (кнопка `–` у правому куті, клік по бару розгортає назад). Стан зберігається у `figma.clientStorage` під ключем `figmosha:mini` і переживає перезапуск. Розміри — у константі `UI_SIZE` в `code.js`.
