// open: висота авто під контент, стеля maxH (= MAX_H в ui.html — там чат стискається під неї)
const UI_SIZE = { open: { w: 320, h: 236, maxH: 600 }, mini: { w: 126, h: 36 } };
figma.showUI(__html__, { width: UI_SIZE.open.w, height: UI_SIZE.open.h, title: "Mistok" });

// відновити згорнутий стан і префи з минулого запуску
let isMini = false;
(async () => {
  try {
    const mini = await figma.clientStorage.getAsync("mistok:mini");
    if (mini) {
      isMini = true;
      figma.ui.resize(UI_SIZE.mini.w, UI_SIZE.mini.h);
      figma.ui.postMessage({ type: "uistate", mini: true });
    }
    const model = await figma.clientStorage.getAsync("mistok:model");
    const effort = await figma.clientStorage.getAsync("mistok:effort");
    if (model || effort) figma.ui.postMessage({ type: "prefsstate", model: model || "", effort: effort || "" });
    const chat = await figma.clientStorage.getAsync("mistok:chat");
    if (chat) { try { figma.ui.postMessage({ type: "chathiststate", hist: JSON.parse(chat) }); } catch (e) {} }
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

// значення в дефолтному моді; аліаси розгортаються ланцюжком (semantic → primitive → …)
async function resolveVarValue(v) {
  for (let hop = 0; v && hop < 10; hop++) {
    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    const val = v.valuesByMode[col.defaultModeId];
    if (!val || val.type !== "VARIABLE_ALIAS") return val;
    v = await figma.variables.getVariableByIdAsync(val.id);
  }
  return undefined;
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

// біндимо тільки в межах скоупа змінної. Порожні scopes = змінна схована з усіх пікерів
// (примітиви під аліасами) — такі не біндимо ніколи; ALL_FILLS покриває всі заливки
function inScope(e, scope) {
  const s = e.scopes || [];
  return s.includes("ALL_SCOPES") || s.includes(scope) || (s.includes("ALL_FILLS") && /_FILL$/.test(scope));
}

// нода всередині інстанса: структуру/позиції міняти не можна (оверрайди імен і заливок — можна)
function inInstance(n) {
  for (let p = n.parent; p && p.type !== "PAGE"; p = p.parent) if (p.type === "INSTANCE") return true;
  return false;
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
      if (!m) { res.skipped.push(n.name + "." + p + "=" + cur); continue; }
      try { n.setBoundVariable(p, m.v); res.changes.push(n.name + "." + p + ": " + cur + " → " + m.v.name); }
      catch (e) { res.skipped.push(n.name + "." + p + " (locked)"); } // напр. всередині інстанса
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
      if (arr) {
        try { n[prop] = arr; } catch (e) { res.skipped.push(n.name + "." + prop + " (locked)"); }
      }
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

// логічні «папки»: сусіди ближче 24px групуються в named group
function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
  return Math.max(dx, dy);
}

async function opFolders(roots, res) {
  for (const parent of walkAll(roots)) {
    if (!parent.children || parent.children.length < 4) continue;
    if (parent.layoutMode && parent.layoutMode !== "NONE") continue;
    if (parent.type === "INSTANCE" || inInstance(parent)) continue;
    const flow = parent.children.filter((k) =>
      typeof k.width === "number" && k.visible !== false &&
      !(k.width * k.height >= parent.width * parent.height * 0.6)); // bg лишається зверху
    if (flow.length < 3) continue;
    const uf = flow.map((_, i) => i);
    const find = (i) => (uf[i] === i ? i : (uf[i] = find(uf[i])));
    for (let i = 0; i < flow.length; i++) {
      for (let j = i + 1; j < flow.length; j++) {
        if (rectGap(flow[i], flow[j]) <= 24) uf[find(i)] = find(j);
      }
    }
    const clusters = {};
    flow.forEach((k, i) => { const r = find(i); (clusters[r] = clusters[r] || []).push(k); });
    for (const key in clusters) {
      const c = clusters[key];
      if (c.length < 2 || c.length === flow.length) continue; // все в одну папку — безглуздо
      const g = figma.group(c, parent);
      const t = g.findOne((x) => x.type === "TEXT" && x.characters.trim());
      g.name = t ? t.characters.trim().slice(0, 24) : "block";
      res.changes.push("folder \"" + g.name + "\" (" + c.length + " items)");
    }
  }
}

// дробові px, які Clean правит і Lint показує: x/y вільних нод (в auto-layout позиція похідна),
// w/h не-текстів з FIXED-розмірами (resize перетворив би HUG/FILL на FIXED)
function freePos(n) {
  return typeof n.x === "number" && (!n.parent || !n.parent.layoutMode || n.parent.layoutMode === "NONE" ||
    n.layoutPositioning === "ABSOLUTE");
}
function fixedSize(n) {
  return typeof n.resize === "function" && n.type !== "TEXT" && typeof n.width === "number" &&
    (!n.layoutSizingHorizontal || (n.layoutSizingHorizontal === "FIXED" && n.layoutSizingVertical === "FIXED"));
}

// Clean = логічні папки + розгрупування зайвого + осмислені імена + цілі px.
// Auto-layout і variables — окремими кнопками (⚏, ⇥, 🎨).
async function opClean(roots, res) {
  await opFolders(roots, res);
  roots = await opRename(roots, res);
  for (const n of walkAll(roots)) {
    if (inInstance(n)) continue;
    if (freePos(n) && (n.x % 1 || n.y % 1)) {
      n.x = Math.round(n.x); n.y = Math.round(n.y);
      res.changes.push(n.name + ": x/y → whole px");
    }
    if (fixedSize(n) && (n.width % 1 || n.height % 1)) {
      try { n.resize(Math.max(1, Math.round(n.width)), Math.max(1, Math.round(n.height))); res.changes.push(n.name + ": w/h → whole px"); }
      catch (e) {}
    }
  }
}

// повертає roots: виділена дефолтна група після ungroup замінюється своїми дітьми
async function opRename(roots, res) {
  const DEFAULT_RE = DEFAULT_NAME_RE;
  // розгрупування: GROUP з дефолтною назвою, найглибші перші (ungroup зберігає дітей)
  const groups = [];
  for (const n of walkAll(roots)) {
    if (n.type === "GROUP" && DEFAULT_RE.test(n.name) && !inInstance(n)) groups.push(n);
  }
  const freed = new Map(); // group → її діти після ungroup
  for (const g of groups.reverse()) {
    const nm = g.name; // після ungroup нода мертва — читати name не можна
    try { freed.set(g, figma.ungroup(g)); res.changes.push("ungrouped " + nm); }
    catch (e) { res.skipped.push(nm + " (ungroup failed)"); }
  }
  roots = roots.flatMap((r) => freed.get(r) || [r]).filter((r) => !r.removed);
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
  return roots;
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
  const num = (v, d) => (v === "" || v == null || !Number.isFinite(+v) ? d : Math.max(0, +v)); // 0 — валідне
  const pad = num(params.pad, 250);
  const gap = num(params.gap, 100);

  let section, items;
  if (roots.length === 1 && roots[0].type === "SECTION") {
    section = roots[0];
    items = section.children.slice();
  } else {
    const parent = roots[0].parent;
    if (!roots.every((n) => n.parent === parent)) {
      throw new Error("selected nodes have different parents — select siblings");
    }
    if (parent.type !== "PAGE" && parent.type !== "SECTION") {
      throw new Error("sections live on the canvas or in sections — select top-level nodes");
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
    res.changes.push("created section \"" + section.name + "\" (" + items.length + " items)");
  }

  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const cols = Math.max(1, Math.round(num(params.cols, 1)));
  let y = pad, maxRight = 0;
  for (let r = 0; r < items.length; r += cols) {
    const rowItems = items.slice(r, r + cols);
    const rowH = Math.max(...rowItems.map((n) => n.height));
    let x = pad;
    for (const n of rowItems) {
      n.x = x; n.y = y;
      res.changes.push(n.name + " → x:" + Math.round(x) + " y:" + Math.round(y));
      x += n.width + gap;
    }
    maxRight = Math.max(maxRight, x - gap);
    y += rowH + gap;
  }
  section.resizeWithoutConstraints(maxRight + pad, y - gap + pad);
  res.changes.push("section " + Math.round(section.width) + "×" + Math.round(section.height) +
    " (pad " + pad + ", gap " + gap + ")");
}

// слоти під картинки: порожні плейсхолдери за іменем АБО листові ноди, де фото вже стоїть
const PH_RE = /^(ph|img|image|photo|picture|placeholder|rectangle)/i;
// дефолтні імена шарів: "Frame 12", "frame13123132312", "Group", "union 3", …
const DEFAULT_NAME_RE = /^(frame|group|rectangle|ellipse|polygon|star|line|arrow|vector|section|union|subtract|intersect|exclude)\s*\d*$/i;
function findImageSlots(roots) {
  const slots = [];
  for (const n of walkAll(roots)) {
    if (typeof n.width !== "number" || !("fills" in n)) continue;
    if (n.children && n.children.length) continue;
    if (n.width < 40 || n.height < 40) continue;
    const hasImage = Array.isArray(n.fills) && n.fills.some((p) => p && p.type === "IMAGE");
    if (hasImage) { slots.push(n); continue; }        // існуюче фото = слот на заміну
    if (PH_RE.test(n.name)) slots.push(n);            // порожній плейсхолдер за іменем
  }
  return slots;
}

// 🖼 reuse: картинки з УСЬОГО файлу → у плейсхолдери за пропорцією (пул кешується 10 хв)
let imgPoolCache = null;
async function opImgReuse(roots, res) {
  let pool;
  if (imgPoolCache && imgPoolCache.file === figma.root.name && Date.now() - imgPoolCache.t < 600000) {
    pool = imgPoolCache.pool;
  } else {
    await figma.loadAllPagesAsync();
    pool = [];
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
    imgPoolCache = { file: figma.root.name, t: Date.now(), pool };
  }
  if (!pool.length) throw new Error("no images in the file to reuse");

  const tokenize = (s) => new Set((s.toLowerCase().match(/[a-zа-яіїєґ]{3,}/gi) || []));
  const contextTokens = (n) => {
    const texts = [];
    let scope = n.parent;
    for (let up = 0; scope && scope.type !== "PAGE" && up < 2; up++) { // тексти сторінки — чужий контекст
      if (scope.findAll) {
        for (const t of scope.findAll((c) => c.type === "TEXT")) {
          const s = t.characters.trim();
          if (s) texts.push(s);
          if (texts.length >= 5) break;
        }
      }
      if (texts.length) break;
      scope = scope.parent;
    }
    return tokenize(n.name + " " + (n.parent ? n.parent.name : "") + " " + texts.join(" "));
  };

  // якість: джерело від 100px по меншій стороні; релевантність: збіг слів
  // контексту слота з іменем джерела; далі пропорція і розмір джерела
  const quality = pool.filter((e) => Math.min(e.w, e.h) >= 100);
  const candidates = quality.length ? quality : pool;
  const used = new Set();
  for (const slot of findImageSlots(roots)) {
    const ownHash = (Array.isArray(slot.fills) && (slot.fills.find((p) => p && p.type === "IMAGE") || {}).imageHash) || null;
    const ctx = contextTokens(slot);
    const ar = slot.width / slot.height;
    const ranked = candidates.map((e) => {
      const srcTok = tokenize(e.from);
      let overlap = 0;
      for (const t of ctx) if (srcTok.has(t)) overlap++;
      return { e, overlap, arDiff: Math.abs(e.w / e.h - ar), area: e.w * e.h };
    }).sort((a, b) => b.overlap - a.overlap || a.arDiff - b.arDiff || b.area - a.area);
    const pick = ranked.find((r) => !used.has(r.e.hash) && r.e.hash !== ownHash) ||
                 ranked.find((r) => r.e.hash !== ownHash) || ranked[0];
    const best = pick.e;
    used.add(best.hash);
    slot.fills = [{ type: "IMAGE", imageHash: best.hash, scaleMode: "FILL" }];
    res.changes.push(slot.name + " ← " + best.from + " (" + Math.round(best.w) + "×" + Math.round(best.h) + ")");
  }
  if (!res.changes.length) res.skipped.push("no image slots found");
}

// ✨ слоти → bridge шукає й вставляє справжні фото з публічного надбання (Openverse)
async function opPhotos(roots, res) {
  const slots = findImageSlots(roots).map((n) => {
    const parent = n.parent;
    const texts = [];
    let scope = parent;
    for (let up = 0; scope && scope.type !== "PAGE" && up < 2; up++) { // тексти сторінки — чужий контекст
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
  if (!slots.length) throw new Error("no image slots found (empty ph/img/photo/… placeholders or leaf nodes with an IMAGE fill)");
  res.photos = { frame: { id: roots[0].id, name: roots[0].name }, slots };
  res.changes.push("photo slots: " + slots.length + " → the bridge fetches public-domain photos");
}

// знімок фреймів для Claude-плану автолейауту (спільний для ⚏ і 📱)
function alSnapshot(targets) {
  return targets.map((f) => ({
    id: f.id, name: f.name, w: Math.round(f.width), h: Math.round(f.height),
    children: f.children.filter((c) => c.visible !== false).map((c) => ({
      id: c.id, name: c.name, type: c.type,
      x: Math.round(c.x), y: Math.round(c.y),
      w: Math.round(c.width || 0), h: Math.round(c.height || 0),
      text: c.type === "TEXT" ? (c.characters || "").slice(0, 60) : undefined,
      bg: (typeof c.width === "number" && c.width * c.height >= f.width * f.height * 0.6) || undefined,
      img: (Array.isArray(c.fills) && c.fills.some((p) => p && p.type === "IMAGE")) || undefined,
      al: c.layoutMode && c.layoutMode !== "NONE" ? c.layoutMode : undefined,
    })),
  }));
}

// smart auto-layout: знімок фрейма → план від Claude → застосовує bridge
async function opAutoLayout(roots, res) {
  // GROUP'и не несуть AL — спершу конвертуємо у фрейми, щоб потрапили в план.
  // findAll іде в документному порядку (зовнішні перші), рефи дітей переживають перенос.
  roots = roots.map((r) => (r.type === "GROUP" && r.children.length > 1 && !inInstance(r) ? frameifyGroup(r) : r));
  const gs = [];
  for (const r of roots) if (r.findAll) gs.push(...r.findAll((n) => n.type === "GROUP" && n.children && n.children.length > 1));
  let framed = 0;
  for (const g of gs) { try { if (!inInstance(g)) { frameifyGroup(g); framed++; } } catch (e) {} }
  if (framed) res.changes.push(framed + " groups → frames");
  const targets = [];
  for (const n of walkAll(roots)) {
    if (n.type === "FRAME" && (!n.layoutMode || n.layoutMode === "NONE") && n.children && n.children.length > 1 && !inInstance(n)) {
      targets.push(n);
    }
  }
  if (!targets.length) throw new Error("no frames without auto-layout with 2+ children in the selection");
  res.alplan = { frames: alSnapshot(targets) };
  res.changes.push("layout snapshot: " + targets.map((t) => t.name).join(", ") + " → Claude plans the auto-layout");
}

// GROUP → FRAME на тих самих межах: групи не мають автолейауту, для рефлоу/плану потрібен фрейм.
// Діти групи в Figma живуть у координатах батька групи — переносимо з поправкою на межі.
function frameifyGroup(g) {
  const parent = g.parent;
  const f = figma.createFrame();
  parent.insertChild(parent.children.indexOf(g), f);
  f.name = g.name;
  f.x = g.x; f.y = g.y;
  f.resize(Math.max(1, g.width), Math.max(1, g.height));
  f.fills = []; f.clipsContent = false;
  const gx = g.x, gy = g.y;
  for (const c of g.children.slice()) {
    const ax = c.x - gx, ay = c.y - gy;
    f.appendChild(c);
    c.x = ax; c.y = ay;
  }
  return f; // порожня група зникає сама
}

// NONE-фрейм зі стеком дітей (типово сторінка з секціями) → VERTICAL AL.
// Оверлеї (nav поверх hero: середина ноди вище кінця попереднього контенту) → ABSOLUTE.
function stackify(f) {
  const kids = f.children.filter(c => c.visible !== false)
    .map(c => c.type === "GROUP" && c.children.length ? frameifyGroup(c) : c);
  if (kids.length < 2) return false;
  const sorted = kids.slice().sort((a, b) => a.y - b.y || b.height - a.height);
  const flow = [], absl = [];
  let flowEnd = -Infinity;
  for (const c of sorted) {
    if (c.y + c.height / 2 < flowEnd) { absl.push(c); continue; }
    flow.push(c); flowEnd = Math.max(flowEnd, c.y + c.height);
  }
  if (flow.length < 2) return false;
  const gaps = [];
  for (let i = 1; i < flow.length; i++) gaps.push(flow[i].y - (flow[i - 1].y + flow[i - 1].height));
  const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 0;
  const padT = Math.max(0, Math.round(Math.min(...flow.map(n => n.y))));
  const padL = Math.max(0, Math.round(Math.min(...flow.map(n => n.x))));
  const padR = Math.max(0, Math.round(f.width - Math.max(...flow.map(n => n.x + n.width))));
  const padB = Math.max(0, Math.round(f.height - Math.max(...flow.map(n => n.y + n.height))));
  const absPos = absl.map(n => ({ n, x: n.x, y: n.y }));
  let i = 0;
  for (const n of absl) f.insertChild(i++, n);
  for (const n of flow) f.insertChild(i++, n);
  const w = f.width, ht = f.height;
  f.layoutMode = "VERTICAL"; // вмикання AL спершу обтягує вміст — повертаємо розмір
  f.primaryAxisSizingMode = "FIXED"; f.counterAxisSizingMode = "FIXED";
  f.resize(w, ht);
  f.itemSpacing = Math.max(0, Math.round(med));
  f.paddingTop = padT; f.paddingRight = padR; f.paddingBottom = padB; f.paddingLeft = padL;
  for (const a of absPos) { try { a.n.layoutPositioning = "ABSOLUTE"; a.n.x = a.x; a.n.y = a.y; } catch (e) {} }
  return true;
}

// мобільна адаптація: клон виділеного фрейма поруч → 375px, реФлоу автолейаутів,
// відступи/гапи/шрифти стиснуті евристикою. Джерело не чіпаємо.
const MOBILE_W = 375;

function mClamp(v, k, lo, hi) { return v ? Math.max(lo, Math.min(hi, Math.round(v * k))) : 0; }

async function mReflow(n, availW, k, isRoot) {
  if (n.type === "TEXT") {
    try {
      const fonts = n.getRangeAllFontNames(0, n.characters.length);
      for (const f of fonts) await figma.loadFontAsync(f);
      if (typeof n.fontSize === "number" && n.fontSize > 20)
        n.fontSize = Math.max(20, Math.round(n.fontSize * 0.62));
      if (n.width > availW) { n.textAutoResize = "HEIGHT"; n.resize(availW, n.height); }
    } catch (e) {}
    return;
  }
  if (!("children" in n)) {
    // листок (картинка/прямокутник) ширший за доступне → стискаємо зі збереженням пропорцій
    try { if (n.width > availW) { const r = availW / n.width; n.resize(availW, Math.max(1, Math.round(n.height * r))); } } catch (e) {}
    return;
  }
  const al = n.layoutMode && n.layoutMode !== "NONE";
  if (!al) {
    // без AL — пропорційний rescale усього піддерева, структуру не вигадуємо
    try { if (n.width > availW && n.rescale) n.rescale(availW / n.width); } catch (e) {}
    return;
  }
  const wide = n.width > availW;
  if (wide) {
    try {
      if (n.layoutMode === "VERTICAL") n.primaryAxisSizingMode = "AUTO"; // висота — під новий вміст
      n.paddingLeft = mClamp(n.paddingLeft, k, 8, 24);
      n.paddingRight = mClamp(n.paddingRight, k, 8, 24);
      n.paddingTop = mClamp(n.paddingTop, k, 8, 64);
      n.paddingBottom = mClamp(n.paddingBottom, k, 8, 64);
      n.itemSpacing = mClamp(n.itemSpacing, k, 4, 40);
    } catch (e) {}
    if (n.layoutMode === "HORIZONTAL") {
      // ряд не влазить → вертикальний стек
      try {
        n.layoutMode = "VERTICAL";
        n.primaryAxisSizingMode = "AUTO";
        n.counterAxisSizingMode = "FIXED";
        n.counterAxisAlignItems = "MIN";
      } catch (e) {}
    }
  }
  if (isRoot) {
    try {
      n.counterAxisSizingMode = "FIXED";
      if (n.layoutMode === "VERTICAL") n.primaryAxisSizingMode = "AUTO";
      n.resize(availW, n.height);
    } catch (e) {}
  }
  const inner = availW - (n.paddingLeft || 0) - (n.paddingRight || 0);
  const vertical = n.layoutMode === "VERTICAL";
  for (const c of n.children.slice()) {
    if (c.layoutPositioning === "ABSOLUTE") {
      try { c.x = Math.round(c.x * k); c.y = Math.round(c.y * k); } catch (e) {}
      continue;
    }
    await mReflow(c, inner, k, false);
    if (vertical) {
      // у вертикальному стеку контейнери й широкий контент тягнуться на всю ширину
      try {
        if (c.type === "TEXT" || (("layoutMode" in c) && c.layoutMode && c.layoutMode !== "NONE") || c.width > inner)
          c.layoutSizingHorizontal = "FILL";
      } catch (e) {}
    }
  }
}

async function opMobile(roots, res) {
  for (const src of roots) {
    if (src.type !== "FRAME" && src.type !== "COMPONENT") { res.skipped.push(src.name + " (not a frame)"); continue; }
    if (src.width <= MOBILE_W) { res.skipped.push(src.name + " (already ≤375)"); continue; }
    const m = src.clone();
    m.name = src.name + " / mobile-375";
    m.x = src.x + src.width + 100;
    m.y = src.y;
    // всі GROUP'и клона → фрейми (групи не вміють AL)
    const gs = m.findAll ? m.findAll((n) => n.type === "GROUP" && n.children && n.children.length > 1) : [];
    for (const g of gs) { try { if (!inInstance(g)) frameifyGroup(g); } catch (e) {} }
    if (!m.layoutMode || m.layoutMode === "NONE") {
      // NONE-корінь: збираємо вертикальний стек (сторінка з секціями)
      if (!stackify(m)) {
        m.remove();
        res.skipped.push(src.name + " (no auto-layout and not a clean vertical stack — run Layout first)");
        continue;
      }
    }
    // NONE-фрейми всередині → Claude планує структуру (як ⚏), потім бридж кличе h.mreflow.
    // Без них — рефлоу одразу тут.
    const targets = [];
    for (const n of walkAll([m])) {
      if (n.type === "FRAME" && (!n.layoutMode || n.layoutMode === "NONE") && n.children && n.children.length > 1 && !inInstance(n)) {
        targets.push(n);
      }
    }
    if (targets.length) { // кілька виділених фреймів → один план на всі клони
      res.mobileplan = res.mobileplan || { cloneIds: [], frames: [] };
      res.mobileplan.cloneIds.push(m.id);
      res.mobileplan.frames.push(...alSnapshot(targets));
      res.changes.push(src.name + ": " + targets.length + " frames → Claude plans auto-layout, then 375 reflow");
    } else {
      await mReflow(m, MOBILE_W, MOBILE_W / src.width, true);
      res.changes.push(src.name + " → mobile 375×" + Math.round(m.height));
    }
    figma.currentPage.selection = [m];
  }
}

// snap до колонок layout grid: x і ширина до колонок; y не чіпаємо
async function opGrid(roots, res) {
  for (const root of roots) {
    let host = root;
    while (host && !(host.layoutGrids || []).some((g) => g.pattern === "COLUMNS" && g.visible !== false)) {
      host = host.parent;
      if (!host || host.type === "PAGE") { host = null; break; }
    }
    if (!host || !root.children) { res.skipped.push(root.name + " (no COLUMNS layout grid)"); continue; }
    if (root.layoutMode && root.layoutMode !== "NONE") { res.skipped.push(root.name + " (auto-layout places its children)"); continue; }
    if (root.type === "INSTANCE" || inInstance(root)) { res.skipped.push(root.name + " (instance internals are locked)"); continue; }
    const grid = host.layoutGrids.find((g) => g.pattern === "COLUMNS" && g.visible !== false);
    const count = grid.count, gutter = grid.gutterSize || 0;
    let colW, colX0;
    if (grid.alignment === "STRETCH") {
      const offset = grid.offset || 0;
      colW = (host.width - offset * 2 - gutter * (count - 1)) / count;
      colX0 = offset;
    } else if (grid.alignment === "CENTER") {
      colW = grid.sectionSize || 60;
      const total = count * colW + (count - 1) * gutter;
      colX0 = (host.width - total) / 2;
    } else {
      colW = grid.sectionSize || 60;
      colX0 = grid.alignment === "MAX"
        ? host.width - (grid.offset || 0) - (count * colW + (count - 1) * gutter)
        : (grid.offset || 0);
    }
    const shift = host === root ? 0 : (root.absoluteTransform[0][2] - host.absoluteTransform[0][2]);
    const colX = (i) => colX0 + i * (colW + gutter);
    const snapX = (x) => {
      let best = colX(0), bd = Infinity;
      for (let i = 0; i < count; i++) { const d = Math.abs(colX(i) - x); if (d < bd) { bd = d; best = colX(i); } }
      return Math.round(best);
    };
    const snapW = (w) => {
      let best = colW, bd = Infinity;
      for (let n = 1; n <= count; n++) {
        const cw = n * colW + (n - 1) * gutter;
        const d = Math.abs(cw - w);
        if (d < bd) { bd = d; best = cw; }
      }
      return Math.round(best);
    };
    for (const n of root.children) {
      if (typeof n.x !== "number") continue;
      const hx = n.x + shift;
      const nx = snapX(hx) - shift;
      const nw = typeof n.resize === "function" && n.type !== "TEXT" ? snapW(n.width) : null;
      const moved = Math.abs(nx - n.x) > 0.5;
      const sized = nw !== null && Math.abs(nw - n.width) > 0.5;
      try {
        if (moved) n.x = nx;
        if (sized) n.resize(nw, n.height);
        if (moved || sized) res.changes.push(n.name + " → x:" + Math.round(nx + shift) + (sized ? " w:" + nw : ""));
      } catch (e) { res.skipped.push(n.name + " (locked)"); }
    }
  }
  if (!res.changes.length && !res.skipped.length) res.skipped.push("nothing to align");
}

// збір текстів на вичитку — виконує headless Claude через bridge.
// Тексти йдуть цілими: обрізаний текст після «виправлення» затер би свій хвіст
async function opSpell(roots, res) {
  const texts = [];
  let long = 0;
  for (const n of walkAll(roots)) {
    if (n.type !== "TEXT") continue;
    const s = n.characters;
    if (!s || s.trim().length < 2) continue;
    if (s.length > 1500) { long++; continue; }
    texts.push({ id: n.id, text: s });
    if (texts.length >= 120) break;
  }
  if (long) res.skipped.push(long + " texts over 1500 chars");
  if (!texts.length) throw new Error("no texts to check in the selection");
  res.spell = { texts };
  res.changes.push("sent to spellcheck: " + texts.length + " texts → Claude runs in background");
}

// запит на редизайн секції за референсами awwwards — виконує Claude-сесія
async function opRedesign(roots, res) {
  const root = roots[0];
  const spec = await HELPERS.spec(root, { maxDepth: 3 });
  res.redesign = {
    frame: { id: root.id, name: root.name, w: Math.round(root.width), h: Math.round(root.height) },
    spec,
    instruction: "awwwards SOTD/honorable mentions → find 2-3 sections similar in meaning → " +
      "works for any selection: group, text block, section or a whole page frame. " +
      "Redraw it in their spirit NEXT TO the original, with impeccable-skill craft applied on top. " +
      "If the source is a bitmap (screenshot/sketch — a frame with one IMAGE rectangle), take a mistok shot and read it visually first. " +
      "Spacing, scale and composition come from the REFERENCE (match its visual rhythm and generous whitespace by eye — " +
      "do NOT copy the source's paddings/gaps). Styling is STRICTLY the file's design system: ONLY its color variables (scopes), " +
      "ONLY its text styles, ONLY existing assets — never invent hex values or ad-hoc fonts; pick the closest token when unsure.",
  };
  res.changes.push("redesign request \"" + root.name + "\" → Claude runs it in background");
}

// запит на прототип із вайрфрейму/скетчу/текстів — виконує Claude-сесія
async function opPrototype(roots, res) {
  const root = roots[0];
  const spec = await HELPERS.spec(root, { maxDepth: 4 });
  res.prototype = {
    frame: { id: root.id, name: root.name, w: Math.round(root.width), h: Math.round(root.height) },
    spec,
    instruction: "build a modern minimalist prototype: Inter, black/white/gray, full auto-layout, " +
      "all texts and logic of the source; if the source is a bitmap, take a shot and read it visually; " +
      "build next to the source",
  };
  res.changes.push("prototype request \"" + root.name + "\" → Claude runs it in background");
}

// док-фрейм зі звітом поруч із першою нодою виділення (на рівні сторінки)
async function placeReport(roots, res, kindLabel) {
  const root0 = roots[0];
  const parent = figma.currentPage;
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Medium" });
  const repName = kindLabel + " · " + root0.name;
  const old = parent.children.find((c) => c.name === repName);
  if (old) old.remove(); // замінюємо власний попередній звіт
  const rep = figma.createFrame();
  parent.appendChild(rep);
  rep.name = repName;
  rep.layoutMode = "VERTICAL";
  rep.primaryAxisSizingMode = "AUTO"; rep.counterAxisSizingMode = "AUTO";
  rep.paddingTop = 20; rep.paddingBottom = 20; rep.paddingLeft = 24; rep.paddingRight = 24;
  rep.itemSpacing = 6; rep.cornerRadius = 8;
  rep.fills = [{ type: "SOLID", color: { r: 0.075, g: 0.075, b: 0.085 } }];
  const abs = root0.absoluteTransform;
  rep.x = abs[0][2] + root0.width + 40;
  rep.y = abs[1][2];
  const title = figma.createText();
  title.fontName = { family: "Inter", style: "Medium" }; title.fontSize = 13;
  title.characters = res.changes[0] || repName;
  title.fills = [{ type: "SOLID", color: { r: 0.95, g: 0.95, b: 0.96 } }];
  rep.appendChild(title);
  for (const line of res.changes.slice(1, 33)) {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: "Regular" }; t.fontSize = 11;
    t.characters = "·  " + line;
    t.fills = [{ type: "SOLID", color: { r: 0.66, g: 0.66, b: 0.7 } }];
    rep.appendChild(t);
  }
  if (res.changes.length > 33) {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: "Regular" }; t.fontSize = 11;
    t.characters = "… +" + (res.changes.length - 33) + " more (see /tmp/mistok-ops.log)";
    t.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.54 } }];
    rep.appendChild(t);
  }
  res.reportPlaced = true;
}

// ── Lint: read-only аудит виділеного — що ще не приведено до системи ─────
async function opLint(roots, res) {
  const floats = await floatVarList();
  const colors = await colorVarList();
  const styles = await figma.getLocalTextStylesAsync();
  const counts = { colors: 0, spacing: 0, textstyles: 0, names: 0, px: 0, offgrid: 0 };

  for (const n of walkAll(roots)) {
    if (DEFAULT_NAME_RE.test(n.name)) { counts.names++; res.changes.push("name: " + n.name); }
    if (!inInstance(n) && ((freePos(n) && (n.x % 1 || n.y % 1)) ||
        (fixedSize(n) && (n.width % 1 || n.height % 1)))) {
      counts.px++; res.changes.push("fractional px: " + n.name);
    }
    for (const prop of ["fills", "strokes"]) {
      const paints = n[prop];
      if (!Array.isArray(paints)) continue;
      const scope = prop === "strokes" ? "STROKE_COLOR"
        : n.type === "TEXT" ? "TEXT_FILL"
        : (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE" || n.type === "SECTION") ? "FRAME_FILL"
        : "SHAPE_FILL";
      for (const p of paints) {
        if (!p || p.type !== "SOLID" || p.visible === false) continue;
        if (p.boundVariables && p.boundVariables.color) continue;
        if (nearestColor(colors, p.color, scope)) {
          counts.colors++; res.changes.push("unbound color: " + n.name + "." + prop);
        }
      }
    }
    if (n.layoutMode && n.layoutMode !== "NONE") {
      for (const pr of AL_PROPS) {
        const cur = n[pr];
        if (typeof cur !== "number" || cur === 0) continue;
        if (n.boundVariables && n.boundVariables[pr]) continue;
        if (nearestNum(floats, cur, "GAP")) { counts.spacing++; res.changes.push("unbound spacing: " + n.name + "." + pr); }
      }
    }
    if (n.type === "TEXT" && !n.textStyleId && typeof n.fontName !== "symbol" && typeof n.fontSize === "number") {
      const cand = styles.some((s) => s.fontName.family === n.fontName.family &&
        s.fontName.style === n.fontName.style && s.fontSize === n.fontSize);
      if (cand) { counts.textstyles++; res.changes.push("no text style: " + n.name); }
    }
  }
  // off-grid: прямі діти фрейма з COLUMNS-сіткою
  for (const root of roots) {
    const grid = (root.layoutGrids || []).find((g) => g.pattern === "COLUMNS" && g.visible !== false);
    if (!grid || !root.children || grid.alignment !== "STRETCH") continue;
    if (root.layoutMode && root.layoutMode !== "NONE") continue; // позиції дає auto-layout
    const count = grid.count, gutter = grid.gutterSize || 0, offset = grid.offset || 0;
    const colW = (root.width - offset * 2 - gutter * (count - 1)) / count;
    for (const n of root.children) {
      if (typeof n.x !== "number") continue;
      let on = false;
      for (let i = 0; i < count; i++) if (Math.abs((offset + i * (colW + gutter)) - n.x) <= 1) { on = true; break; }
      if (!on) { counts.offgrid++; res.changes.push("off-grid: " + n.name + " x:" + Math.round(n.x)); }
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.changes.unshift("LINT: " + total + " issues — colors:" + counts.colors +
    " spacing:" + counts.spacing + " text-styles:" + counts.textstyles +
    " names:" + counts.names + " px:" + counts.px + " off-grid:" + counts.offgrid);
  res.readonly = true;
  if (total > 0) await placeReport(roots, res, "lint");
}

// ── Contrast: WCAG-перевірка текстів проти фактичного фону (read-only) ───
function relLum(c) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrastRatio(a, b) {
  const l1 = Math.max(relLum(a), relLum(b)), l2 = Math.min(relLum(a), relLum(b));
  return (l1 + 0.05) / (l2 + 0.05);
}
async function paintToColor(p) {
  if (!p || p.visible === false) return null;
  if (p.type === "IMAGE") return "IMAGE";
  if (p.type !== "SOLID") return "COMPLEX";
  const bv = p.boundVariables && p.boundVariables.color;
  if (bv) {
    const v = await figma.variables.getVariableByIdAsync(bv.id);
    const val = v ? await resolveVarValue(v) : null;
    if (val && val.r !== undefined) return { r: val.r, g: val.g, b: val.b };
  }
  return { r: p.color.r, g: p.color.g, b: p.color.b };
}
async function effectiveBg(node) {
  let p = node.parent;
  while (p && p.type !== "PAGE") {
    if (Array.isArray(p.fills)) {
      for (let i = p.fills.length - 1; i >= 0; i--) {
        const c = await paintToColor(p.fills[i]);
        if (c) return c;
      }
    }
    p = p.parent;
  }
  return null;
}
async function opContrast(roots, res) {
  let fails = 0, ok = 0;
  for (const n of walkAll(roots)) {
    if (n.type !== "TEXT" || !Array.isArray(n.fills) || !n.fills.length) continue;
    const fg = await paintToColor(n.fills[0]);
    if (!fg || typeof fg === "string") { res.skipped.push(n.name + " (complex fill)"); continue; }
    const bg = await effectiveBg(n);
    if (!bg) { res.skipped.push(n.name + " (no solid bg found)"); continue; }
    if (typeof bg === "string") { res.skipped.push(n.name + " (" + bg.toLowerCase() + " bg — check manually)"); continue; }
    const r = contrastRatio(fg, bg);
    const size = typeof n.fontSize === "number" ? n.fontSize : 16;
    const boldish = typeof n.fontName !== "symbol" && /bold|black|semi|heavy/i.test(n.fontName.style);
    const need = size >= 24 || (size >= 18.7 && boldish) ? 3.0 : 4.5;
    if (r < need) {
      fails++;
      res.changes.push("FAIL " + r.toFixed(2) + " < " + need + ": \"" +
        (n.characters || n.name).slice(0, 30) + "\" (" + Math.round(size) + "px)");
    } else ok++;
  }
  res.changes.unshift("CONTRAST: " + fails + " fail / " + ok + " pass (WCAG AA)");
  res.readonly = true;
  if (fails > 0) await placeReport(roots, res, "contrast");
}

// ◆ pixel-perfect відтворення скріншота у Figma — виконує Claude-сесія
async function opRecreate(roots, res) {
  const root = roots[0];
  res.design = {
    frame: { id: root.id, name: root.name, w: Math.round(root.width), h: Math.round(root.height) },
    instruction: "PIXEL-PERFECT recreation of this screenshot as editable Figma layers, styled STRICTLY with this file's design system. " +
      "mistok shot the source at scale 1-2 and read it carefully; rebuild NEXT TO the source at 1:1 size: " +
      "exact positions and sizes. Colors: ONLY the file's color variables (pick the closest token by eye, respect scopes) — never raw sampled hex. " +
      "Typography: ONLY the file's text styles (closest match); real TEXT nodes. " +
      "Spacing values snap to the file's size variables where close. " +
      "Image areas as IMAGE-fill placeholders. Verify with a side-by-side shot comparison and fix layout deltas before finishing.",
  };
  res.changes.push("recreate request \"" + root.name + "\" → Claude runs it in background");
}

const OPS = { clean: opClean, varsal: opVarsAL, varscolor: opVarsColor,
  textstyle: opTextStyles, sectionize: opSectionize, imgreuse: opImgReuse, photos: opPhotos,
  autolayout: opAutoLayout, grid: opGrid, spell: opSpell, redesign: opRedesign, prototype: opPrototype,
  lint: opLint, contrast: opContrast, recreate: opRecreate, mobile: opMobile };
const OP_NAMES = { clean: "Clean", varsal: "AL→vars", varscolor: "Colors→vars",
  textstyle: "Text styles", sectionize: "Sectionize", imgreuse: "Reuse", photos: "Photos",
  autolayout: "Auto-layout", grid: "Grid snap", spell: "Spellcheck", redesign: "Redesign",
  prototype: "Prototype", lint: "Lint", contrast: "Contrast", recreate: "Recreate", mobile: "Mobile 375" };

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

  // 375-рефлоу вже автолейаутного клона (фінальний крок 📱 Mobile, кличе bridge)
  async mreflow(id) {
    const m = await figma.getNodeByIdAsync(id);
    if (!m) throw new Error("mreflow: node " + id + " not found");
    const w = m.width;
    await mReflow(m, MOBILE_W, MOBILE_W / w, true);
    figma.currentPage.selection = [m];
    figma.viewport.scrollAndZoomIntoView([m]);
    return { w: m.width, h: Math.round(m.height) };
  },

  // Load every unique font in subtree, then run async fn
  async withFonts(rootNode, asyncFn) {
    const texts = rootNode.findAll
      ? rootNode.findAll((n) => n.type === "TEXT")
      : (rootNode.type === "TEXT" ? [rootNode] : []);
    const seen = new Set();
    const fonts = [];
    for (const t of texts) {
      const fns = typeof t.fontName === "symbol" ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
      for (const fn of fns) {
        const key = fn.family + "|" + fn.style;
        if (!seen.has(key)) { seen.add(key); fonts.push(fn); }
      }
    }
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
    return await asyncFn();
  },

  // Set a text node's characters with auto font load (single-font texts only)
  async setText(node, text) {
    if (typeof node.fontName === "symbol") {
      throw new Error("h.setText: text '" + node.name + "' has mixed fonts — use h.replaceText");
    }
    await figma.loadFontAsync(node.fontName);
    node.characters = text;
  },

  // Change a text by rewriting only the span that differs, so per-range styles (bold word,
  // colored link, mixed fonts) survive — the way a typo fix should land
  async replaceText(node, text) {
    const old = node.characters;
    if (old === text) return node;
    const fonts = old.length ? node.getRangeAllFontNames(0, old.length) : [node.fontName];
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
    let a = 0, b = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    const hi = (s, i) => i >= 0 && i < s.length && s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) <= 0xdbff;
    if (hi(old, a - 1)) a--;                            // never split an emoji's surrogate pair
    if (b && hi(old, old.length - 1 - b)) b--;
    if (!a && !b) { node.characters = text; return node; }
    if (old.length - b > a) node.deleteCharacters(a, old.length - b);
    const ins = text.slice(a, text.length - b);
    if (ins) node.insertCharacters(a, ins, a ? "BEFORE" : "AFTER"); // style of the neighbour
    return node;
  },

  // Apply a Smart auto-layout plan from the bridge: wrap planned groups into auto-layout
  // frames, gaps/paddings measured from the real geometry (frame size never changes,
  // overlaps stay free, absolutes keep their spot); targets the plan missed get an axis heuristic
  async alApply(plan, targets) {
    const made = [];
    const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const gapsAlong = (nodes, dir) => {
      const s = nodes.slice().sort((a, b) => (dir === "VERTICAL" ? a.y - b.y : a.x - b.x));
      const g = [];
      for (let i = 1; i < s.length; i++) g.push(dir === "VERTICAL"
        ? s[i].y - (s[i - 1].y + s[i - 1].height) : s[i].x - (s[i - 1].x + s[i - 1].width));
      return { sorted: s, gaps: g };
    };
    const pads = (f, nodes) => ({
      top: Math.max(0, Math.round(Math.min(...nodes.map((n) => n.y)))),
      left: Math.max(0, Math.round(Math.min(...nodes.map((n) => n.x)))),
      right: Math.max(0, Math.round(f.width - Math.max(...nodes.map((n) => n.x + n.width)))),
      bottom: Math.max(0, Math.round(f.height - Math.max(...nodes.map((n) => n.y + n.height)))),
    });
    const stack = (f, dir, nodes, gaps) => {
      const p = pads(f, nodes);
      const w = f.width, ht = f.height;
      f.layoutMode = dir; // вмикання AL спершу обтягує вміст — повертаємо розмір фрейма
      f.primaryAxisSizingMode = "FIXED"; f.counterAxisSizingMode = "FIXED";
      f.resize(w, ht);
      f.itemSpacing = Math.max(0, Math.round(median(gaps)));
      f.paddingTop = p.top; f.paddingRight = p.right; f.paddingBottom = p.bottom; f.paddingLeft = p.left;
    };
    for (const fp of (plan && plan.frames) || []) {
      const f = await figma.getNodeByIdAsync(fp.frameId);
      if (!f || f.type !== "FRAME") continue;
      const dir = fp.direction === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL";
      const flow = [];   // обгортки груп + окремий контент, у порядку плану
      const absl = [];   // absolute-фони
      for (const ch of fp.children || []) {
        if (ch.type === "group") {
          const nodes = [];
          for (const id of ch.ids || []) { const n = await figma.getNodeByIdAsync(id); if (n && n.parent === f) nodes.push(n); }
          if (!nodes.length) continue;
          if (nodes.length === 1) { flow.push(nodes[0]); continue; }
          const gdir = ch.direction === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
          const { sorted, gaps } = gapsAlong(nodes, gdir);
          const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
          const maxX = Math.max(...nodes.map((n) => n.x + n.width)), maxY = Math.max(...nodes.map((n) => n.y + n.height));
          const w = figma.createFrame();
          f.appendChild(w);
          w.name = ch.name || "group"; w.x = minX; w.y = minY;
          w.resize(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
          w.fills = []; w.clipsContent = false;
          for (const n of sorted) { const ax = n.x - minX, ay = n.y - minY; w.appendChild(n); n.x = ax; n.y = ay; }
          if (!gaps.length || median(gaps) >= -2) { // overlap (бейдж на аватарі) → plain wrapper без AL
            w.layoutMode = gdir;
            w.primaryAxisSizingMode = "AUTO"; w.counterAxisSizingMode = "AUTO";
            w.itemSpacing = Math.max(0, Math.round(median(gaps)));
          }
          flow.push(w); made.push(w.name + "x" + nodes.length);
        } else if (ch.id) {
          const n = await figma.getNodeByIdAsync(ch.id);
          if (n && n.parent === f) (ch.absolute ? absl : flow).push(n);
        }
      }
      if (!flow.length) continue;
      let idx = 0; // z-порядок: фони під низ, контент за візуальним порядком
      for (const n of absl) f.insertChild(idx++, n);
      const { sorted, gaps } = gapsAlong(flow, dir);
      for (const n of sorted) f.insertChild(idx++, n);
      if (gaps.length && median(gaps) < -2) { made.push(f.name + ": overlapping top-level items — frame AL skipped"); continue; }
      const absPos = absl.map((n) => ({ n, x: n.x, y: n.y }));
      stack(f, dir, flow, gaps);
      // absolute лише ПІСЛЯ layoutMode, і на свої координати (інакше фон стрибає)
      for (const a of absPos) { try { a.n.layoutPositioning = "ABSOLUTE"; a.n.x = a.x; a.n.y = a.y; } catch (e) {} }
    }
    for (const id of targets || []) { // план загубив ціль або не розпарсився → осьова евристика
      const f = await figma.getNodeByIdAsync(id);
      if (!f || f.type !== "FRAME" || (f.layoutMode && f.layoutMode !== "NONE")) continue;
      const kids = f.children.filter((c) => c.visible !== false);
      if (kids.length < 2) continue;
      for (const dir of ["HORIZONTAL", "VERTICAL"]) {
        const { sorted, gaps } = gapsAlong(kids, dir);
        if (!gaps.length || gaps.some((g) => g < -2)) continue; // перекриття по цій осі
        let i = 0;
        for (const n of sorted) f.insertChild(i++, n);
        stack(f, dir, kids, gaps);
        made.push(f.name + ": fallback " + dir);
        break;
      }
    }
    figma.notify("Smart auto-layout: " + made.length + " groups");
    return made;
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
    const walk = async (n, d, inAL) => {
      const o = { id: n.id, name: n.name, type: n.type };
      if (n.width !== undefined) {
        o.w = Math.round(n.width); o.h = Math.round(n.height);
        // усередині auto-layout позиція похідна — x/y лише для вільних/absolute нод
        if (!inAL || n.layoutPositioning === "ABSOLUTE") {
          o.x = Math.round(n.x); o.y = Math.round(n.y);
        }
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
        const childInAL = !!(n.layoutMode && n.layoutMode !== "NONE");
        o.children = [];
        for (const c of n.children) if (c.visible !== false) o.children.push(await walk(c, d + 1, childInAL));
      }
      return o;
    };
    return await walk(node, 0, false);
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

  // All local text styles — compact, for protocols that must reuse the file's typography
  async stylesDump() {
    const out = [];
    for (const s of await figma.getLocalTextStylesAsync()) {
      const o = { name: s.name, id: s.id,
        font: s.fontName.family + " " + s.fontName.style, size: s.fontSize };
      if (s.lineHeight.unit !== "AUTO")
        o.lineH = s.lineHeight.value + (s.lineHeight.unit === "PERCENT" ? "%" : "px");
      if (s.letterSpacing && s.letterSpacing.value)
        o.letterS = s.letterSpacing.value + (s.letterSpacing.unit === "PERCENT" ? "%" : "px");
      out.push(o);
    }
    return out;
  },

  // Run a panel op from a script (lint, contrast, clean, varscolor, grid, …) on node ids/nodes,
  // default the selection. Returns {changes, skipped, …}; the bridge's follow-up jobs are not started
  async op(kind, nodes, params) {
    const fn = OPS[kind];
    if (!fn) throw new Error("h.op: unknown op '" + kind + "' — one of " + Object.keys(OPS).join(", "));
    const roots = nodes && nodes.length
      ? await Promise.all(nodes.map((n) => (typeof n === "string" ? figma.getNodeByIdAsync(n) : n)))
      : figma.currentPage.selection.slice();
    if (!roots.length || roots.some((n) => !n)) throw new Error("h.op: no nodes — pass ids or select something");
    const res = { changes: [], skipped: [] };
    await fn(roots, res, params || {});
    return res;
  },

  // Quick async accessors
  async node(id)      { return await figma.getNodeByIdAsync(id); },
  async var_(idOrKey) { return await resolveVar(idOrKey); },
  async importComp(key) { return await figma.importComponentByKeyAsync(key); },
  async importVar(key)  { return await figma.variables.importVariableByKeyAsync(key); },
};

// ──────────────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "chathist") {
    try { await figma.clientStorage.setAsync("mistok:chat", JSON.stringify((msg.hist || []).slice(-40))); } catch (e) {}
    return;
  }
  if (msg.type === "prefs") {
    try {
      await figma.clientStorage.setAsync("mistok:model", msg.model || "");
      await figma.clientStorage.setAsync("mistok:effort", msg.effort || "");
    } catch (e) {}
    return;
  }
  if (msg.type === "undo") {
    figma.triggerUndo();
    figma.notify("↩ undone");
    return;
  }
  if (msg.type === "op") {
    const sel = figma.currentPage.selection;
    const fn = OPS[msg.kind];
    const res = { changes: [], skipped: [] };
    try {
      if (!fn) throw new Error("unknown op " + msg.kind);
      if (!sel.length) throw new Error("nothing selected");
      await fn(sel, res, msg.params || {});
      const summary = res.readonly
        ? (res.changes[0] || OP_NAMES[msg.kind])
        : OP_NAMES[msg.kind] + ": " + res.changes.length + " changes" +
          (res.skipped.length ? ", " + res.skipped.length + " skipped" : "");
      figma.notify(summary);
      figma.ui.postMessage({
        type: "opreport", kind: msg.kind, summary,
        roots: sel.map((n) => ({ id: n.id, name: n.name })),
        changes: res.changes.slice(0, 80), skipped: res.skipped.slice(0, 80),
      });
      for (const k of ["design", "redesign", "prototype"]) {
        if (res[k] && msg.params) { res[k].model = msg.params.model || null; res[k].effort = msg.params.effort || null; }
      }
      if (res.photos) figma.ui.postMessage({ type: "photorequest", request: res.photos });
      if (res.spell) figma.ui.postMessage({ type: "spellrequest", texts: res.spell.texts });
      if (res.redesign) figma.ui.postMessage({ type: "redesignrequest", request: res.redesign });
      if (res.prototype) figma.ui.postMessage({ type: "protorequest", request: res.prototype });
      if (res.design) figma.ui.postMessage({ type: "designrequest", request: res.design });
      if (res.alplan) figma.ui.postMessage({ type: "alplanrequest", request: res.alplan });
      if (res.mobileplan) figma.ui.postMessage({ type: "mobileplanrequest", request: res.mobileplan });
      if (!res.readonly || res.reportPlaced) figma.commitUndo(); // мутації і звіт-фрейми = undo-крок
    } catch (e) {
      figma.commitUndo(); // що встигло змінитись до помилки — окремий крок ⌘Z
      figma.notify("Error " + (OP_NAMES[msg.kind] || msg.kind) + ": " + ((e && e.message) || e));
      figma.ui.postMessage({ type: "opreport", kind: msg.kind, error: true,
        summary: "error: " + ((e && e.message) || e), changes: res.changes.slice(0, 80), skipped: [] });
    }
    return;
  }
  if (msg.type === "rmnode") { // «✕ remove result» під відповіддю протоколу
    const n = await figma.getNodeByIdAsync(msg.id);
    if (n) { const nm = n.name; n.remove(); figma.commitUndo(); figma.notify("Removed: " + nm); }
    return;
  }
  if (msg.type === "notify") {
    figma.notify(msg.text || "", { timeout: 5000 });
    return;
  }
  if (msg.type === "shotsel") {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.notify("Nothing selected"); return; }
    const n = sel[0];
    try {
      const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
      const name = (n.name || "node").replace(/[^\wЀ-ӿ-]+/g, "-").slice(0, 40) + ".png";
      figma.ui.postMessage({ type: "file", name, b64: figma.base64Encode(bytes) });
      figma.notify("PNG → clipboard (⌘V) + mistok-shots: " + name);
    } catch (e) {
      figma.notify("Export failed: " + ((e && e.message) || e));
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
      figma.ui.resize(UI_SIZE.open.w, Math.max(90, Math.min(UI_SIZE.open.maxH, Math.round(msg.h))));
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
    figma.commitUndo(); // і те, що встигло змінитись до помилки
    figma.ui.postMessage({
      type: "error",
      id,
      text: (e && e.message) || String(e),
      stack: (e && e.stack) || null,
    });
  }
};
