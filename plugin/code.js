const UI_SIZE = { open: { w: 320, h: 236 }, mini: { w: 126, h: 36 } };
figma.showUI(__html__, { width: UI_SIZE.open.w, height: UI_SIZE.open.h, title: "Mistok" });

// відновити згорнутий стан з минулого запуску
(async () => {
  try {
    const mini = await figma.clientStorage.getAsync("mistok:mini");
    if (mini) {
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
    if (typeof val === "number") out.push({ v, val });
  }
  return out;
}

async function colorVarList() {
  const out = [];
  for (const v of await figma.variables.getLocalVariablesAsync("COLOR")) {
    const val = await resolveVarValue(v);
    if (val && val.r !== undefined) out.push({ v, r: val.r, g: val.g, b: val.b });
  }
  return out;
}

// точний збіг, інакше найближче в межах max(2, 10%); нічого підходящого → null
function nearestNum(list, x) {
  let best = null, bestD = Infinity;
  for (const e of list) {
    const d = Math.abs(e.val - x);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best && bestD <= Math.max(2, x * 0.1)) return best;
  return null;
}

// сума |ΔRGB|; ≤0.06 (~5/канал) вважаємо «нашим» кольором
function nearestColor(list, c) {
  let best = null, bestD = Infinity;
  for (const e of list) {
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
      const m = nearestNum(floats, cur);
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
      let arr = null;
      for (let i = 0; i < paints.length; i++) {
        const p = paints[i];
        if (!p || p.type !== "SOLID" || p.visible === false) continue;
        if (p.boundVariables && p.boundVariables.color) continue;
        const m = nearestColor(colors, p.color);
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
          const m = floats.find((e) => e.val === n.fontSize);
          if (m) { n.setBoundVariable("fontSize", m.v); res.changes.push(n.name + ".fontSize → " + m.v.name); }
        }
        if (typeof n.lineHeight !== "symbol" && n.lineHeight.unit === "PIXELS" &&
            !(n.boundVariables && n.boundVariables.lineHeight)) {
          const m = floats.find((e) => e.val === n.lineHeight.value);
          if (m) { n.setBoundVariable("lineHeight", m.v); res.changes.push(n.name + ".lineHeight → " + m.v.name); }
        }
      } catch (e) { res.skipped.push(n.name + " (font: " + ((e && e.message) || e) + ")"); }
    }
  }
}

async function opClean(roots, res) {
  for (const n of walkAll(roots)) {
    // піксельна сітка: цілі координати й розміри
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
  await opVarsAL(roots, res); // відступи/гапи → variables (250 тощо)
}

async function opRename(roots, res) {
  const DEFAULT_RE = /^(Frame|Group|Rectangle|Ellipse|Polygon|Star|Line|Arrow|Vector|Section) \d+$/;
  // розгрупування: GROUP з дефолтною назвою, найглибші перші (ungroup зберігає дітей)
  const groups = [];
  for (const n of walkAll(roots)) {
    if (n.type === "GROUP" && DEFAULT_RE.test(n.name)) groups.push(n);
  }
  for (const g of groups.reverse()) {
    try { figma.ungroup(g); res.changes.push("розгруповано " + g.name); }
    catch (e) { res.skipped.push(g.name + " (ungroup)"); }
  }
  for (const n of walkAll(roots)) {
    if (!DEFAULT_RE.test(n.name)) continue;
    let name = null;
    const t = n.findOne && n.findOne((c) => c.type === "TEXT" && c.characters.trim());
    if (t) name = t.characters.trim().slice(0, 24);
    else if (Array.isArray(n.fills) && n.fills.some((p) => p && p.type === "IMAGE")) name = "img";
    else if (n.layoutMode === "HORIZONTAL") name = "row";
    else if (n.layoutMode === "VERTICAL") name = "col";
    else if (n.type === "RECTANGLE") name = "box";
    if (name && name !== n.name) { res.changes.push(n.name + " → " + name); n.name = name; }
  }
}

const OPS = { clean: opClean, rename: opRename, varsal: opVarsAL, varscolor: opVarsColor };
const OP_NAMES = { clean: "Clean", rename: "Rename", varsal: "AL→vars", varscolor: "Colors→vars" };

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
  if (msg.type === "op") {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.notify("Нічого не виділено"); return; }
    const fn = OPS[msg.kind];
    if (!fn) return;
    const res = { changes: [], skipped: [] };
    try {
      await fn(sel, res);
      const summary = OP_NAMES[msg.kind] + ": " + res.changes.length + " змін" +
        (res.skipped.length ? ", " + res.skipped.length + " пропущено" : "");
      figma.notify(summary);
      figma.ui.postMessage({
        type: "opreport", kind: msg.kind, summary,
        roots: sel.map((n) => ({ id: n.id, name: n.name })),
        changes: res.changes.slice(0, 80), skipped: res.skipped.slice(0, 80),
      });
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
    const s = msg.mini ? UI_SIZE.mini : UI_SIZE.open;
    figma.ui.resize(s.w, s.h);
    try { await figma.clientStorage.setAsync("mistok:mini", !!msg.mini); } catch (e) {}
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
  } catch (e) {
    figma.ui.postMessage({
      type: "error",
      id,
      text: (e && e.message) || String(e),
      stack: (e && e.stack) || null,
    });
  }
};
