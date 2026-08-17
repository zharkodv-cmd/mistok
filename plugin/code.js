const UI_SIZE = { open: { w: 320, h: 236 }, mini: { w: 126, h: 36 } };
figma.showUI(__html__, { width: UI_SIZE.open.w, height: UI_SIZE.open.h, title: "Mistok" });

// відновити згорнутий стан з минулого запуску
let isMini = false;
(async () => {
  try {
    const mini = await figma.clientStorage.getAsync("mistok:mini");
    if (mini) {
      isMini = true;
      figma.ui.resize(UI_SIZE.mini.w, UI_SIZE.mini.h);
      figma.ui.postMessage({ type: "uistate", mini: true });
    }
  } catch (e) {}
})();

// поточне виділення → UI (рядок з id + copy)
function sendSelection() {
  const all = figma.currentPage.selection;
  const nodes = all.slice(0, 10).map((n) => ({
    id: n.id, name: n.name, type: n.type,
    w: Math.round(n.width || 0), h: Math.round(n.height || 0),
  }));
  figma.ui.postMessage({ type: "selection", nodes, total: all.length });
}
figma.on("selectionchange", sendSelection);
sendSelection();

// ─── selection ops (кнопки в UI) ─────────────────────────────────────────

async function resolveVarValue(v) {
  const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  let val = v.valuesByMode[col.defaultModeId];
  if (val && val.type === "VARIABLE_ALIAS") {
    const t = await figma.variables.getVariableByIdAsync(val.id);
    if (!t) return undefined;
    const tc = await figma.variables.getVariableCollectionByIdAsync(t.variableCollectionId);
    val = t.valuesByMode[tc.defaultModeId];
  }
  return val;
}

async function floatVarList() {
  const out = [];
  for (const v of await figma.variables.getLocalVariablesAsync("FLOAT")) {
    const val = await resolveVarValue(v);
    if (typeof val === "number") out.push({ v, val, scopes: v.scopes });
  }
  return out;
}

async function colorVarList() {
  const out = [];
  for (const v of await figma.variables.getLocalVariablesAsync("COLOR")) {
    const val = await resolveVarValue(v);
    if (val && val.r !== undefined) out.push({ v, r: val.r, g: val.g, b: val.b, scopes: v.scopes });
  }
  return out;
}

// скоупи у файлі розставлені — біндимо тільки в межах свого скоупа
function inScope(e, scope) {
  return !e.scopes || !e.scopes.length || e.scopes.includes("ALL_SCOPES") || e.scopes.includes(scope);
}

// точний збіг, інакше найближче в межах max(2, 10%) — лише серед свого скоупа
function nearestNum(list, x, scope) {
  let best = null, bestD = Infinity;
  for (const e of list) {
    if (scope && !inScope(e, scope)) continue;
    const d = Math.abs(e.val - x);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best && bestD <= Math.max(2, x * 0.1)) return best;
  return null;
}

// сума |ΔRGB| ≤ 0.06 — лише серед свого скоупа
function nearestColor(list, c, scope) {
  let best = null, bestD = Infinity;
  for (const e of list) {
    if (scope && !inScope(e, scope)) continue;
    const d = Math.abs(e.r - c.r) + Math.abs(e.g - c.g) + Math.abs(e.b - c.b);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best && bestD <= 0.06) return best;
  return null;
}

function walkAll(roots) {
  const out = [];
  for (const r of roots) {
    out.push(r);
    if (r.findAll) out.push(...r.findAll(() => true));
  }
  return out;
}

const AL_PROPS = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];

async function opVarsAL(roots, res) {
  const floats = await floatVarList();
  for (const n of walkAll(roots)) {
    if (!n.layoutMode || n.layoutMode === "NONE") continue;
    for (const p of AL_PROPS) {
      const cur = n[p];
      if (typeof cur !== "number" || cur === 0) continue;
      if (n.boundVariables && n.boundVariables[p]) continue; // вже прив'язано
      const m = nearestNum(floats, cur, "GAP");
      if (m) { n.setBoundVariable(p, m.v); res.changes.push(n.name + "." + p + ": " + cur + " → " + m.v.name); }
      else res.skipped.push(n.name + "." + p + "=" + cur);
    }
  }
}

async function opVarsColor(roots, res) {
  const colors = await colorVarList();
  const floats = await floatVarList();
  for (const n of walkAll(roots)) {
    for (const prop of ["fills", "strokes"]) {
      const paints = n[prop];
      if (!Array.isArray(paints) || !paints.length) continue;
      const scope = prop === "strokes" ? "STROKE_COLOR"
        : n.type === "TEXT" ? "TEXT_FILL"
        : (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE" || n.type === "SECTION") ? "FRAME_FILL"
        : "SHAPE_FILL";
      let arr = null;
      for (let i = 0; i < paints.length; i++) {
        const p = paints[i];
        if (!p || p.type !== "SOLID" || p.visible === false) continue;
        if (p.boundVariables && p.boundVariables.color) continue;
        const m = nearestColor(colors, p.color, scope);
        if (m) {
          arr = arr || JSON.parse(JSON.stringify(paints));
          arr[i] = figma.variables.setBoundVariableForPaint(arr[i], "color", m.v);
          res.changes.push(n.name + "." + prop + "[" + i + "] → " + m.v.name);
        } else {
          res.skipped.push(n.name + "." + prop + "[" + i + "]");
        }
      }
      if (arr) n[prop] = arr;
    }
    // текст: fontSize / lineHeight — тільки точний збіг
    if (n.type === "TEXT" && typeof n.fontName !== "symbol") {
      try {
        await figma.loadFontAsync(n.fontName);
        if (typeof n.fontSize === "number" && !(n.boundVariables && n.boundVariables.fontSize)) {
          const m = floats.find((e) => e.val === n.fontSize && inScope(e, "FONT_SIZE"));
          if (m) { n.setBoundVariable("fontSize", m.v); res.changes.push(n.name + ".fontSize → " + m.v.name); }
        }
        if (typeof n.lineHeight !== "symbol" && n.lineHeight.unit === "PIXELS" &&
            !(n.boundVariables && n.boundVariables.lineHeight)) {
          const m = floats.find((e) => e.val === n.lineHeight.value && inScope(e, "LINE_HEIGHT"));
          if (m) { n.setBoundVariable("lineHeight", m.v); res.changes.push(n.name + ".lineHeight → " + m.v.name); }
        }
      } catch (e) { res.skipped.push(n.name + " (font: " + ((e && e.message) || e) + ")"); }
    }
  }
}

async function opClean(roots, res) {
  await opRename(roots, res); // 1. імена + розгрупування
  for (const n of walkAll(roots)) {
    // 2. піксельна сітка: цілі координати й розміри
    if (typeof n.x === "number" && (n.x % 1 || n.y % 1)) {
      n.x = Math.round(n.x); n.y = Math.round(n.y);
      res.changes.push(n.name + ": x/y → ціле");
    }
    if (typeof n.resize === "function" && n.type !== "TEXT" &&
        typeof n.width === "number" && (n.width % 1 || n.height % 1)) {
      try { n.resize(Math.round(n.width), Math.round(n.height)); res.changes.push(n.name + ": w/h → ціле"); }
      catch (e) {}
    }
  }
  try { await opAutoLayout(roots, res); } catch (e) {} // 3. логічний auto-layout (нема кандидатів — ок)
  await opVarsAL(roots, res); // 4. відступи/гапи → variables (скоуп GAP)
}

async function opRename(roots, res) {
  // дефолтні імена: "Frame 12", "frame13123132312", "Group", "union 3", …
  const DEFAULT_RE = /^(frame|group|rectangle|ellipse|polygon|star|line|arrow|vector|section|union|subtract|intersect|exclude)\s*\d*$/i;
  // розгрупування: GROUP з дефолтною назвою, найглибші перші (ungroup зберігає дітей)
  const groups = [];
  for (const n of walkAll(roots)) {
    if (n.type === "GROUP" && DEFAULT_RE.test(n.name)) groups.push(n);
  }
  for (const g of groups.reverse()) {
    try { figma.ungroup(g); res.changes.push("розгруповано " + g.name); }
    catch (e) { res.skipped.push(g.name + " (ungroup)"); }
  }
  // item: ≥3 дефолтних сусідів одного розміру = повторюваний елемент
  const itemNamed = new Set();
  const parents = new Set();
  for (const n of walkAll(roots)) if (n.children && n.children.length) parents.add(n);
  for (const p of parents) {
    const bySize = {};
    for (const c of p.children) {
      if (!DEFAULT_RE.test(c.name) || typeof c.width !== "number") continue;
      const key = Math.round(c.width) + "x" + Math.round(c.height);
      (bySize[key] = bySize[key] || []).push(c);
    }
    for (const key in bySize) {
      if (bySize[key].length < 3) continue;
      for (const c of bySize[key]) { res.changes.push(c.name + " → item"); c.name = "item"; itemNamed.add(c.id); }
    }
  }
  for (const n of walkAll(roots)) {
    if (itemNamed.has(n.id) || !DEFAULT_RE.test(n.name)) continue;
    const parent = n.parent;
    const maxDim = typeof n.width === "number" ? Math.max(n.width, n.height) : 0;
    const hasImg = Array.isArray(n.fills) && n.fills.some((p) => p && p.type === "IMAGE");
    let name = null;
    if (parent && typeof parent.width === "number" && typeof n.width === "number" &&
        n.width * n.height >= parent.width * parent.height * 0.6) name = "bg";
    else if (hasImg) name = n.type === "ELLIPSE" ? "avatar" : "image";
    else {
      const t = n.findOne && n.findOne((c) => c.type === "TEXT" && c.characters.trim());
      if (t) name = t.characters.trim().slice(0, 24);
      else if (n.layoutMode === "HORIZONTAL") name = "row";
      else if (n.layoutMode === "VERTICAL") name = "col";
      else if (n.type === "LINE" || (typeof n.height === "number" && n.height <= 4 && n.width >= 40)) name = "divider";
      else if (n.type === "ELLIPSE") name = maxDim <= 16 ? "dot" : "circle";
      else if (n.type === "VECTOR" || n.type === "STAR" || n.type === "POLYGON" ||
               n.type === "BOOLEAN_OPERATION") name = maxDim <= 48 ? "icon" : "vector";
      else if (n.type === "RECTANGLE") name = "bg";
    }
    if (name && name !== n.name) { res.changes.push(n.name + " → " + name); n.name = name; }
  }
}

// текстові ноди → локальні Text Styles (збіг family+style+size, уточнення за lineHeight)
async function opTextStyles(roots, res) {
  const styles = await figma.getLocalTextStylesAsync();
  for (const n of walkAll(roots)) {
    if (n.type !== "TEXT") continue;
    if (n.textStyleId) continue; // вже зі стилем
    if (typeof n.fontName === "symbol" || typeof n.fontSize === "symbol") {
      res.skipped.push(n.name + " (mixed font)");
      continue;
    }
    const cand = styles.filter((s) =>
      s.fontName.family === n.fontName.family &&
      s.fontName.style === n.fontName.style &&
      s.fontSize === n.fontSize);
    if (!cand.length) {
      res.skipped.push(n.name + " (" + n.fontName.family + " " + n.fontName.style + " " + n.fontSize + ")");
      continue;
    }
    let best = cand[0];
    if (cand.length > 1 && typeof n.lineHeight !== "symbol") {
      const lh = JSON.stringify(n.lineHeight);
      best = cand.find((s) => JSON.stringify(s.lineHeight) === lh) || cand[0];
    }
    try {
      await figma.loadFontAsync(best.fontName);
      await n.setTextStyleIdAsync(best.id);
      res.changes.push(n.name + " → " + best.name);
    } catch (e) {
      res.skipped.push(n.name + " (" + ((e && e.message) || e) + ")");
    }
  }
}

// загорнути виділене в SECTION і розкласти вертикально (pad всередині, gap між)
async function opSectionize(roots, res, params) {
  const pad = Number(params && params.pad) || 250;
  const gap = Number(params && params.gap) || 100;

  let section, items;
  if (roots.length === 1 && roots[0].type === "SECTION") {
    section = roots[0];
    items = section.children.slice();
  } else {
    const parent = roots[0].parent;
    if (!roots.every((n) => n.parent === parent)) {
      throw new Error("виділені ноди мають різних батьків — виділи сусідів");
    }
    section = figma.createSection();
    const minX = Math.min(...roots.map((n) => n.x));
    const minY = Math.min(...roots.map((n) => n.y));
    parent.appendChild(section);
    section.x = minX; section.y = minY;
    items = roots.slice();
    const t = roots.map((n) => n.findOne && n.findOne((c) => c.type === "TEXT" && c.characters.trim())).find(Boolean);
    section.name = t ? t.characters.trim().slice(0, 32) : "Section";
    for (const n of items) section.appendChild(n);
    res.changes.push("створено секцію «" + section.name + "» (" + items.length + " ел.)");
  }

  items.sort((a, b) => a.y - b.y || a.x - b.x);
  let y = pad, maxW = 0;
  for (const n of items) {
    n.x = pad; n.y = y;
    y += n.height + gap;
    maxW = Math.max(maxW, n.width);
    res.changes.push(n.name + " → x:" + pad + " y:" + Math.round(n.y));
  }
  section.resizeWithoutConstraints(maxW + pad * 2, y - gap + pad);
  res.changes.push("секція " + Math.round(section.width) + "×" + Math.round(section.height) +
    " (pad " + pad + ", gap " + gap + ")");
}

// плейсхолдери під картинки: за іменем або сірий прямокутник без дітей
const PH_RE = /^(ph|img|image|photo|picture|placeholder|rectangle)/i;
function findImageSlots(roots) {
  const slots = [];
  for (const n of walkAll(roots)) {
    if (typeof n.width !== "number" || !("fills" in n)) continue;
    if (n.children && n.children.length) continue;
    const hasImage = Array.isArray(n.fills) && n.fills.some((p) => p && p.type === "IMAGE");
    if (hasImage) continue;
    if (PH_RE.test(n.name) && n.width >= 40 && n.height >= 40) slots.push(n);
  }
  return slots;
}

// 🖼 reuse: картинки з УСЬОГО файлу → у плейсхолдери за пропорцією
async function opImgReuse(roots, res) {
  await figma.loadAllPagesAsync();
  const pool = [];
  const seen = new Set();
  for (const pg of figma.root.children) {
    for (const n of pg.findAll((c) => Array.isArray(c.fills))) {
      for (const p of n.fills) {
        if (p && p.type === "IMAGE" && p.imageHash && !seen.has(p.imageHash)) {
          seen.add(p.imageHash);
          pool.push({ hash: p.imageHash, w: n.width, h: n.height, from: pg.name + "/" + n.name });
        }
      }
    }
  }
  if (!pool.length) throw new Error("у файлі немає жодної картинки для повторного використання");
  const used = new Set();
  for (const slot of findImageSlots(roots)) {
    const ar = slot.width / slot.height;
    const ranked = pool.slice().sort((a, b) =>
      Math.abs(a.w / a.h - ar) - Math.abs(b.w / b.h - ar));
    const best = ranked.find((e) => !used.has(e.hash)) || ranked[0];
    used.add(best.hash);
    slot.fills = [{ type: "IMAGE", imageHash: best.hash, scaleMode: "FILL" }];
    res.changes.push(slot.name + " ← " + best.from);
  }
  if (!res.changes.length) res.skipped.push("плейсхолдерів не знайдено (імена ph/img/photo/… без дітей)");
}

// ✨ запит на преміум-генерацію через Magnific — виконує Claude-сесія
async function opImgRequest(roots, res) {
  const slots = findImageSlots(roots).map((n) => {
    const parent = n.parent;
    const texts = [];
    let scope = parent;
    for (let up = 0; scope && up < 2; up++) {
      if (scope.findAll) {
        for (const t of scope.findAll((c) => c.type === "TEXT")) {
          const s = t.characters.trim();
          if (s) texts.push(s.slice(0, 90));
          if (texts.length >= 5) break;
        }
      }
      if (texts.length) break;
      scope = scope.parent;
    }
    return { id: n.id, name: n.name, w: Math.round(n.width), h: Math.round(n.height),
             parent: parent ? parent.name : null, context: texts };
  });
  if (!slots.length) throw new Error("плейсхолдерів не знайдено (імена ph/img/photo/… без дітей)");
  res.request = {
    file: figma.root.name,
    frame: { id: roots[0].id, name: roots[0].name },
    slots,
  };
  res.changes.push("запит на " + slots.length + " картинок → скажи Claude: «встав картинки»");
}

// логічний auto-layout для фрейма з вільно розставленими дітьми
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function alBind(node, prop, floats, res) {
  const m = nearestNum(floats, node[prop], "GAP");
  if (m) { node.setBoundVariable(prop, m.v); res.changes.push(node.name + "." + prop + " → " + m.v.name); }
}

function alApply(f, res, floats) {
  const all = f.children.slice();
  // фонові шари (покривають >85% фрейма) — виводимо з потоку
  const bg = [], kids = [];
  for (const k of all) {
    (k.width * k.height > f.width * f.height * 0.85 ? bg : kids).push(k);
  }
  if (kids.length < 2) { res.skipped.push(f.name + " (<2 елементів у потоці)"); return; }

  // кластеризація в рядки за перекриттям по y
  kids.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const k of kids) {
    const row = rows.find((r) => {
      const top = Math.min(...r.map((n) => n.y));
      const bot = Math.max(...r.map((n) => n.y + n.height));
      const ov = Math.min(bot, k.y + k.height) - Math.max(top, k.y);
      return ov > Math.min(k.height, bot - top) * 0.5;
    });
    if (row) row.push(k); else rows.push([k]);
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));

  let items;
  let dir = "VERTICAL";
  if (rows.length === 1) {
    dir = "HORIZONTAL";
    items = rows[0];
  } else {
    items = rows.map((r) => {
      if (r.length === 1) return r[0];
      // багатоелементний рядок → обгортка row з HORIZONTAL AL
      const minX = Math.min(...r.map((n) => n.x));
      const minY = Math.min(...r.map((n) => n.y));
      const maxX = Math.max(...r.map((n) => n.x + n.width));
      const maxY = Math.max(...r.map((n) => n.y + n.height));
      const wrap = figma.createFrame();
      f.appendChild(wrap);
      wrap.x = minX; wrap.y = minY;
      wrap.resize(maxX - minX, maxY - minY);
      wrap.fills = []; wrap.name = "row"; wrap.clipsContent = false;
      const gaps = [];
      for (let i = 1; i < r.length; i++) gaps.push(Math.max(0, r[i].x - (r[i - 1].x + r[i - 1].width)));
      for (const n of r) { const ax = n.x - minX, ay = n.y - minY; wrap.appendChild(n); n.x = ax; n.y = ay; }
      wrap.layoutMode = "HORIZONTAL";
      wrap.primaryAxisSizingMode = "FIXED"; wrap.counterAxisSizingMode = "FIXED";
      wrap.itemSpacing = Math.round(median(gaps));
      alBind(wrap, "itemSpacing", floats, res);
      res.changes.push(f.name + ": row×" + r.length + " gap:" + wrap.itemSpacing);
      return wrap;
    });
    items.sort((a, b) => a.y - b.y);
  }

  // порядок дітей = візуальний порядок (AL стекає за індексом)
  items.forEach((n, i) => f.insertChild(i, n));

  const minX = Math.min(...items.map((n) => n.x));
  const minY = Math.min(...items.map((n) => n.y));
  const maxX = Math.max(...items.map((n) => n.x + n.width));
  const maxY = Math.max(...items.map((n) => n.y + n.height));
  const gaps = [];
  for (let i = 1; i < items.length; i++) {
    gaps.push(Math.max(0, dir === "VERTICAL"
      ? items[i].y - (items[i - 1].y + items[i - 1].height)
      : items[i].x - (items[i - 1].x + items[i - 1].width)));
  }

  f.layoutMode = dir;
  f.primaryAxisSizingMode = "FIXED"; f.counterAxisSizingMode = "FIXED";
  f.itemSpacing = Math.round(median(gaps));
  f.paddingLeft = Math.max(0, Math.round(minX));
  f.paddingTop = Math.max(0, Math.round(minY));
  f.paddingRight = Math.max(0, Math.round(f.width - maxX));
  f.paddingBottom = Math.max(0, Math.round(f.height - maxY));
  for (const p of ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
    if (f[p] > 0) alBind(f, p, floats, res);
  }

  for (const b of bg) { b.layoutPositioning = "ABSOLUTE"; res.changes.push(b.name + " → absolute (фон)"); }
  res.changes.push(f.name + ": " + dir + " gap:" + f.itemSpacing +
    " pad:" + [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft].join(","));
}

async function opAutoLayout(roots, res) {
  const targets = [];
  for (const root of roots) {
    if (root.type === "FRAME" && (!root.layoutMode || root.layoutMode === "NONE") && root.children.length > 1) {
      targets.push(root);
    } else if (root.type === "SECTION" || (root.type === "FRAME" && root.layoutMode !== "NONE")) {
      for (const c of root.children) {
        if (c.type === "FRAME" && (!c.layoutMode || c.layoutMode === "NONE") && c.children.length > 1) targets.push(c);
      }
    }
  }
  if (!targets.length) throw new Error("нема фреймів без auto-layout з 2+ дітьми");
  const floats = await floatVarList();
  for (const f of targets) alApply(f, res, floats);
}

const OPS = { clean: opClean, rename: opRename, varsal: opVarsAL, varscolor: opVarsColor,
  textstyle: opTextStyles, sectionize: opSectionize, imgreuse: opImgReuse, imggen: opImgRequest,
  autolayout: opAutoLayout };
const OP_NAMES = { clean: "Clean", rename: "Rename", varsal: "AL→vars", varscolor: "Colors→vars",
  textstyle: "Text styles", sectionize: "Sectionize", imgreuse: "Img reuse", imggen: "Magnific request",
  autolayout: "Auto-layout" };

function safeStringify(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) {
    try { return String(value); } catch (e2) { return null; }
  }
}

function asText(value, logs) {
  try {
    if (value !== undefined) {
      return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    }
  } catch (e) { /* unserializable — fall back to logs */ }
  return logs.length > 0 ? logs.join("\n") : "Done";
}

// ─── helpers exposed as `h.*` to every exec ──────────────────────────────

async function resolveVar(varOrId) {
  if (varOrId == null) return null;
  if (typeof varOrId === "string") {
    return await figma.variables.getVariableByIdAsync(varOrId);
  }
  return varOrId;
}

const HELPERS = {
  // Bind fill paint at index to a variable (id or instance)
  async bF(node, idx, varOrId) {
    const v = await resolveVar(varOrId);
    if (!v) throw new Error("h.bF: variable not found: " + varOrId);
    const f = JSON.parse(JSON.stringify(node.fills));
    f[idx] = figma.variables.setBoundVariableForPaint(f[idx], "color", v);
    node.fills = f;
    return v;
  },

  // Bind stroke paint at index
  async bS(node, idx, varOrId) {
    const v = await resolveVar(varOrId);
    if (!v) throw new Error("h.bS: variable not found: " + varOrId);
    const s = JSON.parse(JSON.stringify(node.strokes));
    s[idx] = figma.variables.setBoundVariableForPaint(s[idx], "color", v);
    node.strokes = s;
    return v;
  },

  // Bind numeric property (radii, padding, sizes, itemSpacing, etc.)
  async bN(node, prop, varOrId) {
    const v = await resolveVar(varOrId);
    if (!v) throw new Error("h.bN: variable not found: " + varOrId);
    node.setBoundVariable(prop, v);
    return v;
  },

  // First descendant by exact name
  findByName(root, name) {
    return root.findOne((n) => n.name === name);
  },

  // All descendants by exact name
  findAllByName(root, name) {
    return root.findAll((n) => n.name === name);
  },

  // Dump subtree as indented text
  dumpTree(node, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth == null ? 99 : opts.maxDepth;
    const showSize = opts.showSize !== false;
    const showText = opts.showText !== false;
    const lines = [];
    const walk = (n, d) => {
      if (d > maxDepth) return;
      const pad = "  ".repeat(d);
      let line = pad + n.name + " [" + n.type + "] " + n.id;
      if (showSize && n.width !== undefined) {
        line += " " + Math.round(n.width) + "×" + Math.round(n.height);
      }
      if (showText && n.type === "TEXT") line += ' "' + n.characters + '"';
      lines.push(line);
      if (n.children) for (const c of n.children) walk(c, d + 1);
    };
    walk(node, 0);
    return lines.join("\n");
  },

  // Load every unique font in subtree, then run async fn
  async withFonts(rootNode, asyncFn) {
    const texts = rootNode.findAll
      ? rootNode.findAll((n) => n.type === "TEXT")
      : (rootNode.type === "TEXT" ? [rootNode] : []);
    const seen = new Set();
    const fonts = [];
    for (const t of texts) {
      if (typeof t.fontName === "symbol") continue;
      const fn = t.fontName;
      const key = fn.family + "|" + fn.style;
      if (!seen.has(key)) { seen.add(key); fonts.push(fn); }
    }
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
    return await asyncFn();
  },

  // Set a text node's characters with auto font load (single-font texts only)
  async setText(node, text) {
    if (typeof node.fontName === "symbol") {
      throw new Error("h.setText: text '" + node.name + "' has mixed fonts; load each range manually");
    }
    await figma.loadFontAsync(node.fontName);
    node.characters = text;
  },

  // Clone node and place it next to the original
  cloneNext(node, opts) {
    opts = opts || {};
    const direction = opts.direction || "right";
    const gap = opts.gap == null ? 100 : opts.gap;
    const c = node.clone();
    node.parent.appendChild(c);
    if (direction === "right") { c.x = node.x + node.width + gap; c.y = node.y; }
    else if (direction === "left")  { c.x = node.x - node.width - gap; c.y = node.y; }
    else if (direction === "down")  { c.x = node.x; c.y = node.y + node.height + gap; }
    else if (direction === "up")    { c.x = node.x; c.y = node.y - node.height - gap; }
    if (opts.name) c.name = opts.name;
    return c;
  },

  // Set instance variant properties
  async variant(instance, props) {
    await instance.setProperties(props);
    return instance;
  },

  // Available variants for an instance's component
  async variantsOf(instance) {
    const main = await instance.getMainComponentAsync();
    if (!main) return null;
    const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    return set
      ? { current: main.name, groups: set.variantGroupProperties, all: set.children.map(c => c.name) }
      : { current: main.name, groups: null, all: null };
  },

  // Compact design spec of a subtree — geometry, auto-layout, fills/strokes
  // as hex or var(name), typography, effects. Skips invisible nodes and defaults.
  async spec(node, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth == null ? 99 : opts.maxDepth;
    const varNames = {};
    const varName = async (id) => {
      if (varNames[id]) return varNames[id];
      try {
        const v = await figma.variables.getVariableByIdAsync(id);
        return (varNames[id] = v ? v.name : id);
      } catch (e) { return id; }
    };
    const to2 = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
    const hex = (c) => "#" + to2(c.r) + to2(c.g) + to2(c.b);
    const paint = async (p) => {
      if (!p || p.visible === false) return null;
      const bv = p.boundVariables && p.boundVariables.color;
      if (bv) return "var(" + (await varName(bv.id)) + ")";
      if (p.type === "SOLID") {
        const op = p.opacity != null && p.opacity < 1 ? "@" + Math.round(p.opacity * 100) + "%" : "";
        return hex(p.color) + op;
      }
      if (p.type === "IMAGE") return "IMAGE:" + (p.imageHash || "?") + " " + (p.scaleMode || "");
      return p.type; // GRADIENT_LINEAR, …
    };
    const walk = async (n, d) => {
      const o = { id: n.id, name: n.name, type: n.type };
      if (n.width !== undefined) {
        o.w = Math.round(n.width); o.h = Math.round(n.height);
        o.x = Math.round(n.x); o.y = Math.round(n.y);
      }
      if (n.layoutMode && n.layoutMode !== "NONE") {
        o.layout = n.layoutMode + " gap:" + n.itemSpacing +
          " pad:" + [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].join(",") +
          " " + n.primaryAxisSizingMode + "/" + n.counterAxisSizingMode;
        if (n.primaryAxisAlignItems !== "MIN") o.justify = n.primaryAxisAlignItems;
        if (n.counterAxisAlignItems !== "MIN") o.align = n.counterAxisAlignItems;
      }
      if (Array.isArray(n.fills) && n.fills.length) {
        const fs = [];
        for (const p of n.fills) { const s = await paint(p); if (s) fs.push(s); }
        if (fs.length) o.fills = fs;
      }
      if (Array.isArray(n.strokes) && n.strokes.length) {
        const ss = [];
        for (const p of n.strokes) { const s = await paint(p); if (s) ss.push(s); }
        if (ss.length) { o.strokes = ss; o.strokeW = n.strokeWeight; }
      }
      if (typeof n.cornerRadius === "number" && n.cornerRadius > 0) o.radius = n.cornerRadius;
      if (n.opacity != null && n.opacity < 1) o.opacity = Math.round(n.opacity * 100) / 100;
      if (n.type === "TEXT") {
        o.text = n.characters;
        if (typeof n.fontName !== "symbol") o.font = n.fontName.family + " " + n.fontName.style;
        if (typeof n.fontSize !== "symbol") o.fontSize = n.fontSize;
        if (typeof n.lineHeight !== "symbol" && n.lineHeight.unit !== "AUTO")
          o.lineH = n.lineHeight.value + (n.lineHeight.unit === "PERCENT" ? "%" : "px");
        if (typeof n.letterSpacing !== "symbol" && n.letterSpacing.value)
          o.letterS = n.letterSpacing.value + (n.letterSpacing.unit === "PERCENT" ? "%" : "px");
        if (n.textAlignHorizontal !== "LEFT") o.textAlign = n.textAlignHorizontal;
      }
      if (n.effects && n.effects.length) {
        const ef = n.effects.filter((e) => e.visible !== false)
          .map((e) => e.type + " " + (e.radius || 0) + "px");
        if (ef.length) o.effects = ef;
      }
      if (n.layoutGrids && n.layoutGrids.length) {
        o.grids = n.layoutGrids.filter((g) => g.visible !== false).map((g) =>
          g.pattern + (g.count ? " count:" + g.count : "") +
          (g.gutterSize != null ? " gutter:" + g.gutterSize : "") +
          (g.offset != null ? " offset:" + g.offset : "") +
          (g.sectionSize != null ? " size:" + g.sectionSize : "") +
          (g.alignment ? " " + g.alignment : ""));
      }
      if (n.children && d < maxDepth) {
        o.children = [];
        for (const c of n.children) if (c.visible !== false) o.children.push(await walk(c, d + 1));
      }
      return o;
    };
    return await walk(node, 0);
  },

  // Dump all local variables grouped by collection; aliases as →name, colors as hex
  async varsDump() {
    const to2 = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
    const out = {};
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (const col of cols) {
      const vars = [];
      for (const id of col.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (!v) continue;
        const vals = {};
        for (const m of col.modes) {
          let val = v.valuesByMode[m.modeId];
          if (val && val.type === "VARIABLE_ALIAS") {
            const t = await figma.variables.getVariableByIdAsync(val.id);
            val = "→" + (t ? t.name : val.id);
          } else if (val && val.r !== undefined) {
            val = "#" + to2(val.r) + to2(val.g) + to2(val.b) + (val.a < 1 ? to2(val.a) : "");
          }
          vals[m.name] = val;
        }
        vars.push({ name: v.name, type: v.resolvedType, id: v.id,
          value: col.modes.length === 1 ? vals[col.modes[0].name] : vals });
      }
      out[col.name] = { modes: col.modes.map((m) => m.name), count: vars.length, vars };
    }
    return out;
  },

  // Quick async accessors
  async node(id)      { return await figma.getNodeByIdAsync(id); },
  async var_(idOrKey) { return await resolveVar(idOrKey); },
  async importComp(key) { return await figma.importComponentByKeyAsync(key); },
  async importVar(key)  { return await figma.variables.importVariableByKeyAsync(key); },
};

// ──────────────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "undo") {
    figma.triggerUndo();
    figma.notify("↩ відкат");
    return;
  }
  if (msg.type === "op") {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.notify("Нічого не виділено"); return; }
    const fn = OPS[msg.kind];
    if (!fn) return;
    const res = { changes: [], skipped: [] };
    try {
      await fn(sel, res, msg.params || {});
      const summary = OP_NAMES[msg.kind] + ": " + res.changes.length + " змін" +
        (res.skipped.length ? ", " + res.skipped.length + " пропущено" : "");
      figma.notify(summary);
      figma.ui.postMessage({
        type: "opreport", kind: msg.kind, summary,
        roots: sel.map((n) => ({ id: n.id, name: n.name })),
        changes: res.changes.slice(0, 80), skipped: res.skipped.slice(0, 80),
      });
      if (res.request) figma.ui.postMessage({ type: "imgrequest", request: res.request });
      figma.commitUndo(); // кожна операція = окремий крок undo
    } catch (e) {
      figma.notify("Помилка " + OP_NAMES[msg.kind] + ": " + ((e && e.message) || e));
    }
    return;
  }
  if (msg.type === "notify") {
    figma.notify(msg.text || "", { timeout: 5000 });
    return;
  }
  if (msg.type === "shotsel") {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.notify("Нічого не виділено"); return; }
    const n = sel[0];
    try {
      const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
      const name = (n.name || "node").replace(/[^\wЀ-ӿ-]+/g, "-").slice(0, 40) + ".png";
      figma.ui.postMessage({ type: "file", name, b64: figma.base64Encode(bytes) });
      figma.notify("PNG → буфер (⌘V) + mistok-shots: " + name);
    } catch (e) {
      figma.notify("Експорт не вдався: " + ((e && e.message) || e));
    }
    return;
  }
  if (msg.type === "ui") {
    isMini = !!msg.mini;
    const s = msg.mini ? UI_SIZE.mini : UI_SIZE.open;
    figma.ui.resize(s.w, s.h);
    try { await figma.clientStorage.setAsync("mistok:mini", !!msg.mini); } catch (e) {}
    return;
  }
  if (msg.type === "resize") {
    if (!isMini && typeof msg.h === "number") {
      figma.ui.resize(UI_SIZE.open.w, Math.max(90, Math.min(500, Math.round(msg.h))));
    }
    return;
  }
  if (msg.type !== "exec") return;
  const { id, code } = msg;

  const logs = [];
  const print = (...args) => {
    const text = args.map((a) =>
      typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
    ).join(" ");
    logs.push(text);
    figma.ui.postMessage({ type: "log", id, text });
  };

  try {
    const fn = new Function(
      "figma", "print", "h",
      `return (async () => { ${code} })();`
    );
    const result = await fn(figma, print, HELPERS);

    figma.ui.postMessage({
      type: "result",
      id,
      text: asText(result, logs),
      value: safeStringify(result),
    });
    figma.commitUndo(); // кожен exec = окремий крок undo
  } catch (e) {
    figma.ui.postMessage({
      type: "error",
      id,
      text: (e && e.message) || String(e),
      stack: (e && e.stack) || null,
    });
  }
};
