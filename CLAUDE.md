# Mistok — Claude Code instructions

Drive Figma by sending JS code through a local bridge that's connected to a custom plugin running inside Figma Desktop. The panel chat of the plugin runs headless Claude Code in this folder — this file is its context too.

**Per-project design conventions live in `projects/<name>.md`** (git-ignored, local). Before design work in a Figma file, check `projects/` for a matching md (e.g. file "Coast Flight" → `projects/coast-flight.md`) and read it first. Append dated decisions to its history section as you make them.

## How to send code

```bash
# Preferred — subcommand-style
mistok exec "return figma.currentPage.name"
mistok exec --file script.js

# Shorthand (auto-prepends `exec`)
mistok "return figma.currentPage.name"

# High-level commands save tokens for common operations
mistok text 185:21880 "Привіт"            # keeps per-range styles, loads fonts
mistok variant 185:21883 "Property 1=Default"
mistok shot 185:21880 out.png --scale 2   # PNG export straight to file — NO base64 in context
mistok spec 185:21880 --depth 3           # design spec, compact JSON — use INSTEAD of custom extraction JS
mistok vars                               # all local variables by collection
mistok styles                             # all local text styles — use INSTEAD of getLocalTextStylesAsync via exec
mistok focus 185:21880                    # scroll viewport to node + select (щоб показати користувачу)
mistok sel                                # current selection — use when user says «цей фрейм»

# Quick HTTP (no Python needed)
curl -s -X POST http://localhost:8787/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"return figma.currentPage.id"}'

# Status
curl -s http://localhost:8787/status   # {"plugin_connected": true/false, "pending": 0}
```

If the bridge isn't running: `launchctl kickstart -k gui/$(id -u)/com.mistok.bridge` (launchd agent written by `install.sh`; log at `/tmp/mistok-bridge.log`).

If the plugin isn't connected: tell the user — `Plugins → Development → Mistok` (or ⌘⌥P).

## Helpers (available as `h.*` in every exec)

| Helper | What |
|---|---|
| `await h.bF(node, idx, varOrId)` | Bind fill paint to variable (id or instance) |
| `await h.bS(node, idx, varOrId)` | Bind stroke paint to variable |
| `await h.bN(node, prop, varOrId)` | Bind numeric prop (radius, padding, size...) |
| `h.findByName(root, name)` | First descendant by exact name |
| `h.findAllByName(root, name)` | All descendants by exact name |
| `h.dumpTree(node, {maxDepth, showSize, showText})` | Indented tree string |
| `await h.withFonts(root, asyncFn)` | Loads every font in subtree (mixed ones too), then runs `asyncFn` |
| `await h.setText(node, text)` | Set single-font TEXT chars with auto font load |
| `await h.replaceText(node, text)` | Rewrite only the differing span — mixed fonts / per-range styles survive |
| `h.cloneNext(node, {direction, gap, name})` | Clone + place adjacent (`right`/`left`/`up`/`down`) |
| `await h.variant(instance, props)` | Wrapper around `instance.setProperties(...)` |
| `await h.variantsOf(instance)` | `{ current, groups, all }` for the component set |
| `await h.node(id)` | Shorthand for `figma.getNodeByIdAsync(id)` |
| `await h.var_(idOrKey)` | Resolve a variable from id or instance |
| `await h.importComp(key)` | `figma.importComponentByKeyAsync(key)` |
| `await h.importVar(key)` | `figma.variables.importVariableByKeyAsync(key)` |
| `await h.spec(node, {maxDepth})` | Compact design spec — geometry, layout, fills as hex/`var(name)`/`IMAGE:<hash>`, typography, layout grids. Inside auto-layout x/y omitted (derived) |
| `await h.varsDump()` | Local variables by collection, aliases as `→name`, colors as hex |
| `await h.stylesDump()` | Local text styles — name, id, font, size, lineH, letterS |
| `await h.op(kind, ids?, params?)` | Run a panel op (`lint`, `contrast`, `clean`, `varsal`, `varscolor`, `textstyle`, `grid`, …) on ids or the selection → `{changes, skipped}` |

**Use them.** Compared to inline boilerplate, helpers save ~70% of the script and avoid common mistakes (frozen `node.fills`, missing `loadFontAsync`, etc.). `h.alApply` / `h.mreflow` are internal steps of the Layout / Mobile buttons.

## CLI subcommands (save tokens for common ops)

| Command | Equivalent JS | Use case |
|---|---|---|
| `mistok tree <id>` | `h.dumpTree(await h.node(id))` | Explore node structure |
| `mistok find <id> name=Button` | `(await h.node(id)).findAll(n => n.name === "Button")` | Locate by name |
| `mistok find <id> name~Btn` | `findAll(n => n.name.includes("Btn"))` | Substring name match |
| `mistok find <id> type=INSTANCE` | `findAll(n => n.type === "INSTANCE")` | Filter by type |
| `mistok find <id> text~Привіт` | `findAll(n => n.type === "TEXT" && n.characters.includes(...))` | Find by text |
| `mistok text <id> "новий"` | `await h.replaceText(n, "новий")` | Edit text safely |
| `mistok variant <id> "Property 1=Default"` | `await n.setProperties({...})` | Switch variant |
| `mistok clone <id> --right --gap 100` | `h.cloneNext(n, {direction:'right',gap:100})` | Duplicate adjacent |
| `mistok rm <id>` | `n.remove()` | Delete |
| `mistok icomp <key>` | `(await h.importComp(key)).createInstance()` | Pull from library |
| `mistok shot <id> out.png [--scale 2]` | `exportAsync` → decode locally | Screenshot, no base64 in context |
| `mistok spec <id> [--depth N]` | `await h.spec(n, {maxDepth})` | Compact design spec JSON |
| `mistok vars` | `await h.varsDump()` | All variables by collection |
| `mistok styles` | `await h.stylesDump()` | All local text styles |
| `mistok focus <id>` | `scrollAndZoomIntoView` + select | Show a node to the user |
| `mistok sel` | `figma.currentPage.selection.map(...)` | What the user selected («цей фрейм») |
| `mistok img <id> file.png` | `createImage` → IMAGE fill | Local picture into a node |

Use subcommands when the op fits one of these. Fall back to `exec` for anything else.

## How exec evaluates code

```js
new Function("figma", "print", "h", `return (async () => { <YOUR CODE> })();`)(figma, print, HELPERS)
```

- `return ...` becomes the `result` field of the response (stringified + raw `value` if JSON-serializable).
- `await` works everywhere.
- `print(...)` collects log lines (returned in the `logs` array).
- Exceptions → `{ok:false, error, hint?, stack, logs}` with HTTP 500.
- Every exec is one undo step (also when it throws halfway).

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
- **`teamlibrary permission not specified`** (or similar): manifest needs a new permission. Edit `plugin/manifest.json`, then ask user to **re-import** the plugin (Plugins → Development → Manage plugins → remove + Import again).
- **Result looks weird / undefined**: you forgot `return`. The wrapper expects a value.
- **Switch Figma file → plugin disconnects**: plugin is bound to the open file. After switching, ask user to Run plugin again.

## Where things live

- Bridge, CLI, plugin: this repo. Figma loads the plugin straight from `plugin/` — edits to `code.js` / `ui.html` apply on the next **Run**; only `manifest.json` changes need a re-import.
- `install.sh` — venv, the `mistok` command, the launchd agent `com.mistok.bridge` (RunAtLoad + KeepAlive). Re-run after `git pull`.
- Log: `/tmp/mistok-bridge.log`. Self-test: `./venv/bin/python tests/test_bridge.py`.
- `plugin/ui.html` VERSION must equal `PLUGIN_VERSION` in `bridge.py` — the panel warns the user to re-run an outdated plugin.

```bash
curl -s http://localhost:8787/status                      # перевірка
launchctl kickstart -k gui/$(id -u)/com.mistok.bridge   # примусовий рестарт
launchctl bootout gui/$(id -u)/com.mistok.bridge        # зупинити зовсім
```

Плагін у Figma після рестарту bridge перепідключається сам (~2 с). Запуск плагіна: **⌘⌥P** (повторити останній плагін) — автозапуску dev-плагінів Figma не має.

## UI плагіна

Темна тема, статус-дот (пульсує, поки йде робота; ✕ Cancel з'являється лише тоді). Зверху вниз: limit-бари Claude (session/weekly/модельні, notify при ≥80%), рядок виділення (id + ⧉ copy, `</>` промпт «implement this design», 📷 PNG @2x у `~/Desktop/mistok-shots/` і в системний буфер), 16 кнопок операцій над виділенням (таблиця в README), чат із Claude.

Чат: поле вводу → bridge запускає headless `claude -p` у цій папці з власною розмовою (`--session-id`/`--resume`, id у `.chat-session`), `/new` — нова розмова; URL замість тексту = веб-імпорт сторінки в шари. Модель/effort (✦/↯) діють і на Claude-кнопки. Висота вікна авто під контент, стеля 600 px (історія чату стискається); згорнутий стан — пігулка 126×36 (`figma.clientStorage` `mistok:mini`).

Звіти кнопок-операцій bridge пише в **`/tmp/mistok-ops.log`** (JSONL: ts, kind, roots, changes, skipped) — коли користувач каже «глянь що зробив Clean», читай цей файл. «Найближчі» variables: точний збіг або в межах толерансу (числа max(2px, 10%), кольори ΔRGB ≤ 0.06), лише в межах scopes змінної (порожні scopes = прихований примітив, не біндимо; ALL_FILLS покриває всі заливки); що не підійшло — у `skipped`. Кожна операція — один ⌘Z. Lint і Contrast — read-only (звіт-фрейм поруч із виділенням).

## Картинки

**Кнопка ✨ Photos**: з `FREEPIK_API_KEY` (env або `.env`) bridge сам шукає фото на Freepik за текстами поруч зі слотом, haiku ранжує, вставляє. Без ключа — пише запит у `/tmp/mistok-image-request.json` (frame, слоти: id/розміри/сусідні тексти). Коли користувач каже «встав картинки» — прочитай запит, знайди і скачай через **Magnific MCP** готові фото (НЕ генеруй AI-картинки, якщо прямо не попросили) і встав кожне через **`mistok img <slotId> file.png`** (CLI сам кодує байти — ніколи не тягни base64 через контекст). Після виконання видали файл запиту.

Якість фото:
- Спершу арт-дирекшн проєкту (`projects/<name>.md`, токени кольорів) — промпт має йому відповідати.
- Промпт конкретний: сюжет, композиція, світло, палітра (hex з токенів), стиль зйомки. Без «beautiful modern image».
- Заборонено: текст/вотермарки, перенасичений HDR, сток-генерик, артефакти анатомії. Виглядає як слоп чи сток-кліше → обери інше фото, не вставляй.
- Розмір/аспект під цільову ноду (з `spec`). Для hero-місць 2–3 варіанти, показати користувачу перед масовим заповненням.

## Протоколи Redesign / Prototype / Design (кнопки ⟳ ▭ ◆)

Кнопки виконуються **автоматично**: bridge пише запит у `/tmp/mistok-{redesign,prototype,design}-request.json` і запускає headless-сесію (opus або модель з ✦) з контекстом `headless/CLAUDE.md` — там повні правила протоколів (строго змінні/текст-стилі файлу, anti-slop, розміщення, review-агент). Прогрес стрімиться в панель, результат — прев'ю з кнопкою «remove result».

Якщо користувач просить виконати протокол у звичайній сесії («редизайнь секцію», «зроби прототип», «recreate the design») — прочитай відповідний файл запиту й дій за `headless/CLAUDE.md`. Розміщення результату — ЗАВЖДИ поруч із джерелом: той самий батько/сторінка, `x = source.x + source.width + 100`, `y = source.y`. Після виконання видали файл запиту.

## Smart auto-layout (кнопка Layout) і Mobile

Плагін шле знімок дітей фрейма (позиції + прапорці bg/img/text/al) → headless Claude (sonnet, без тулів) повертає ЛИШЕ структуру (групи, порядок, напрямок, absolute-фони) → плагінний `h.alApply` рахує gap/padding із фактичної геометрії (медіана відстаней, реальні відступи до країв) і застосовує. Розмір фрейма ніколи не змінюється; overlap-елементи лишаються без AL; absolute-фони повертаються на свої координати; що план пропустив (або план не прийшов) — осьова евристика. Mobile робить те саме для клона, потім `h.mreflow` стискає його до 375.
