# Mistok — Claude Code instructions

Drive Figma by sending JS code through a local bridge that's connected to a custom plugin running inside Figma Desktop.

**Per-project design conventions live in `projects/<name>.md`.** Before design work in a Figma file, check `projects/` for a matching md (e.g. file "Coast Flight" → `projects/coast-flight.md`) and read it first. Append dated decisions to its "Історія рішень" section as you make them.

## How to send code

```bash
# Preferred — subcommand-style
mistok exec "return figma.currentPage.name"
mistok exec --file script.js

# Shorthand (auto-prepends `exec`)
mistok "return figma.currentPage.name"

# High-level commands (covered below) save tokens for common operations
mistok text 185:21880 "Привіт"
mistok variant 185:21883 "Property 1=Default"
mistok shot 185:21880 out.png --scale 2   # PNG export straight to file — NO base64 in context
mistok spec 185:21880 --depth 3           # design spec, compact JSON — use INSTEAD of custom extraction JS
mistok vars                               # all local variables by collection
mistok sel                                # current selection — use when user says «цей фрейм»

# Quick HTTP (no Python needed)
curl -s -X POST http://localhost:8787/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"return figma.currentPage.id"}'

# Status
curl -s http://localhost:8787/status   # {"plugin_connected": true/false, "pending": 0}
```

If the bridge isn't running: `launchctl kickstart -k gui/$(id -u)/com.mistok.bridge` (launchd agent; logs at `/tmp/mistok-bridge.log`).

If the plugin isn't connected: tell the user — `Plugins → Development → Mistok → Run` (or ⌘⌥P).

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
| `await h.spec(node, {maxDepth})` | Compact design spec — geometry, layout, fills as hex/`var(name)`/`IMAGE:<hash>`, typography, layout grids |
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
| `mistok tree <id>` | `h.dumpTree(await h.node(id))` | Explore node structure |
| `mistok find <id> name=Button` | `(await h.node(id)).findAll(n => n.name === "Button")` | Locate by name |
| `mistok find <id> name~Btn` | `findAll(n => n.name.includes("Btn"))` | Substring name match |
| `mistok find <id> type=INSTANCE` | `findAll(n => n.type === "INSTANCE")` | Filter by type |
| `mistok find <id> text~Привіт` | `findAll(n => n.type === "TEXT" && n.characters.includes(...))` | Find by text |
| `mistok text <id> "новий"` | `await h.setText(n, "новий")` | Edit text safely |
| `mistok variant <id> "Property 1=Default"` | `await n.setProperties({...})` | Switch variant |
| `mistok clone <id> --right --gap 100` | `h.cloneNext(n, {direction:'right',gap:100})` | Duplicate adjacent |
| `mistok rm <id>` | `n.remove()` | Delete |
| `mistok icomp <key>` | `(await h.importComp(key)).createInstance()` | Pull from library |
| `mistok shot <id> out.png [--scale 2]` | `exportAsync` → decode locally | Screenshot, no base64 in context |
| `mistok spec <id> [--depth N]` | `await h.spec(n, {maxDepth})` | Compact design spec JSON |
| `mistok vars` | `await h.varsDump()` | All variables by collection |
| `mistok sel` | `figma.currentPage.selection.map(...)` | What the user selected («цей фрейм») |

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
- **`teamlibrary permission not specified`** (or similar): manifest needs a new permission. Edit `plugin/manifest.json` (Figma loads it straight from `~/Code/mistok/plugin/`), then ask user to **re-import** the plugin (Plugins → Development → Manage plugins → remove + Import again).
- **Result looks weird / undefined**: you forgot `return`. The wrapper expects a value.
- **Switch Figma file → plugin disconnects**: plugin is bound to the open file. After switching, ask user to Run plugin again.

The error response includes a `hint` field for common cases — read it before debugging.

## Where things live (macOS, актуально)

Усе локально, ніякого WSL і синхронізації.

- Bridge + плагін: `~/Code/mistok/`
- Figma Desktop вантажить плагін **напряму з репозиторію** — `~/Code/mistok/plugin/` (перевірено в `~/Library/Application Support/Figma/settings.json`). Правки в `code.js` / `ui.html` підхоплюються після **Run**, копіювати нікуди не треба. Re-Import потрібен лише при зміні `manifest.json`.
- Venv: `~/Code/mistok/venv/` (arm64, Python 3.12)
- Log: `/tmp/mistok-bridge.log`

Bridge запускається **автоматично через launchd** — агент `~/Library/LaunchAgents/com.mistok.bridge.plist` (RunAtLoad + KeepAlive: стартує при логіні, сам рестартиться після падіння). Вручну запускати нічого не треба.

```bash
curl -s http://localhost:8787/status                      # перевірка
launchctl kickstart -k gui/$(id -u)/com.mistok.bridge   # примусовий рестарт
launchctl bootout gui/$(id -u)/com.mistok.bridge        # зупинити зовсім
```

Плагін у Figma після рестарту bridge перепідключається сам (~2 с). Запуск плагіна: **⌘⌥P** (повторити останній плагін) — автозапуску dev-плагінів Figma не має.

## Картинки: Magnific MCP

Коли користувач просить заповнити фрейми картинками — генеруй через **Magnific MCP**, тільки якісні стильові зображення, ніякого AI-слопу:

- Спершу арт-дирекшн проєкту (`projects/<name>.md`, токени кольорів) — промпт має йому відповідати.
- Промпт конкретний: сюжет, композиція, світло, палітра (hex з токенів), стиль зйомки. Без «beautiful modern image».
- Заборонено: текст/вотермарки, перенасичений HDR, сток-генерик, артефакти анатомії. Виглядає як слоп → перегенеруй, не вставляй.
- Розмір/аспект під цільову ноду (з `spec`). Вставка: bytes → `figma.createImage` → IMAGE-філ `scaleMode:'FILL'`.
- Для hero-місць 2–3 варіанти, показати користувачу перед масовим заповненням.

## UI плагіна

Темна тема, статус-дот, кольоровий лог. Зверху вниз: limit-бари Claude (session/weekly, notify при ≥80%), рядок виділення (id + кнопки **⧉** copy та **📷** — PNG @2x у `~/Desktop/mistok-shots/` і в системний буфер), **кнопки операцій над виділенням** (🧹 Clean — цілі px + AL→variables; ✏️ Rename — дефолтні `Frame N` за вмістом + розгрупування `Group N`; ⇥ AL — відступи/гапи → найближчі FLOAT variables; 🎨 Colors — кольори/fontSize/lineHeight → найближчі variables), stats-рядок (тривалість сесії, проєкт, msgs, токени — push з bridge кожні 60 с), summary сесії, лог з підсвіткою мутацій (`[exec✎]`).

Звіти кнопок-операцій bridge пише в **`/tmp/mistok-ops.log`** (JSONL: ts, kind, roots, changes, skipped) — коли користувач каже «глянь що зробив Clean», читай цей файл. «Найближчі» variables: точний збіг або в межах толерансу (числа max(2px, 10%), кольори ΔRGB ≤ 0.06); що не підійшло — у `skipped`. Все відкочується одним ⌘Z. Вікно згортається в компактну пігулку (кнопка `–`, клік розгортає). Стан у `figma.clientStorage` під ключем `mistok:mini`. Розміри — `UI_SIZE` в `code.js` (open 320×316, mini 126×36). Тайтл-бар із хрестиком — хром Figma, його прибрати не можна.
