const UI_SIZE = { open: { w: 320, h: 200 }, mini: { w: 126, h: 36 } };
figma.showUI(__html__, { width: UI_SIZE.open.w, height: UI_SIZE.open.h, title: "Figmosha" });

// відновити згорнутий стан з минулого запуску
(async () => {
  try {
    const mini = await figma.clientStorage.getAsync("figmosha:mini");
    if (mini) {
      figma.ui.resize(UI_SIZE.mini.w, UI_SIZE.mini.h);
      figma.ui.postMessage({ type: "uistate", mini: true });
    }
  } catch (e) {}
})();

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
      return p.type; // GRADIENT_LINEAR, IMAGE, …
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
  if (msg.type === "ui") {
    const s = msg.mini ? UI_SIZE.mini : UI_SIZE.open;
    figma.ui.resize(s.w, s.h);
    try { await figma.clientStorage.setAsync("figmosha:mini", !!msg.mini); } catch (e) {}
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
