#!/usr/bin/env python3
"""webimport — turn a live web page into editable Figma layers via the Mistok bridge.

Usage (run with the mistok venv python — playwright lives there):
    ./venv/bin/python webimport.py <url> [--width 1440] [--max-nodes 600] [--port 8787]

Needs: ./venv/bin/pip install playwright && ./venv/bin/playwright install chromium
(or ./install.sh --with-import).

Pipeline: Playwright opens the page → DOM walk captures visible boxes with computed
styles (bg, border, radius, text, images) → one exec script builds absolutely
positioned frames/texts/rects in Figma. Then the plugin buttons finish the job:
Clean (names/folders), ⇥/🎨 (bind to nearest variables), T (text styles).
"""

import argparse
import base64
import json
import sys
import urllib.request

EXTRACT_JS = r"""
() => {
  const MAX = %MAX%;
  const out = [];
  const push = (el, depth) => {
    if (out.length >= MAX) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (r.bottom < 0 || r.right < 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;

    // прямий текст елемента (без тексту нащадків)
    let text = "";
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3) text += ch.textContent;
    }
    text = text.replace(/\s+/g, " ").trim();

    const bg = cs.backgroundColor;
    const hasBg = bg && !bg.startsWith("rgba(0, 0, 0, 0)") && bg !== "transparent";
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const isImg = el.tagName === "IMG";
    const bgImg = cs.backgroundImage && cs.backgroundImage.startsWith("url(")
      ? cs.backgroundImage.slice(5, -2) : null;

    // елемент вартий шару, якщо в нього є видима коробка, текст або картинка
    const worth = hasBg || text || isImg || bgImg || bw > 0;
    if (worth) {
      out.push({
        i: out.length, depth,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        bg: hasBg ? bg : null,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        bw: bw > 0 ? bw : null,
        bc: bw > 0 ? cs.borderTopColor : null,
        text: text ? text.slice(0, 400) : null,
        color: text ? cs.color : null,
        fs: text ? parseFloat(cs.fontSize) : null,
        fwBold: text ? parseInt(cs.fontWeight, 10) >= 600 : false,
        lh: text && cs.lineHeight.endsWith("px") ? parseFloat(cs.lineHeight) : null,
        align: text ? cs.textAlign : null,
        src: isImg ? (el.currentSrc || el.src) : bgImg,
        tag: el.tagName.toLowerCase(),
      });
    }
    for (const ch of el.children) push(ch, depth + 1);
  };
  push(document.body, 0);
  return {
    page: { w: Math.round(document.documentElement.scrollWidth),
            h: Math.round(Math.min(document.documentElement.scrollHeight, 6000)),
            title: document.title },
    els: out,
  };
}
"""


def rgb(css):
    """'rgb(12, 34, 56)' / 'rgba(...)' → {r,g,b,a} 0..1"""
    if not css or "(" not in css:
        return None
    parts = css[css.index("(") + 1:css.rindex(")")].split(",")
    try:
        r, g, b = (float(parts[i]) / 255 for i in range(3))
        a = float(parts[3]) if len(parts) > 3 else 1.0
        return {"r": r, "g": g, "b": b, "a": a}
    except (ValueError, IndexError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--max-nodes", type=int, default=600)
    ap.add_argument("--port", type=int, default=8787, help="bridge port")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("[import] web import needs Playwright: ./install.sh --with-import")

    print(f"[import] opening {args.url}", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": args.width, "height": 900})
        page.goto(args.url, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(1000)
        data = page.evaluate(EXTRACT_JS.replace("%MAX%", str(args.max_nodes)))

        # картинки: топ-30 найбільших, до 500KB кожна
        imgs = {}
        seen = set()
        img_els = sorted([e for e in data["els"] if e.get("src")],
                         key=lambda e: e["w"] * e["h"], reverse=True)[:30]
        for e in img_els:
            src = e["src"]
            if src in seen or src.startswith("data:"):
                if src.startswith("data:") and "," in src:
                    imgs[src] = src.split(",", 1)[1][:700000]
                continue
            seen.add(src)
            try:
                body = page.request.get(src, timeout=15000).body()
                if 100 < len(body) <= 500 * 1024:
                    imgs[src] = base64.b64encode(body).decode()
            except Exception:
                pass
        browser.close()

    els = data["els"]
    pg = data["page"]
    print(f"[import] {len(els)} elements, {len(imgs)} images → building in Figma", flush=True)

    payload = json.dumps({"page": pg, "els": els, "imgs": imgs}, ensure_ascii=False)
    build = """
const D = %PAYLOAD%;
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Bold" });

const root = figma.createFrame();
root.name = "import: " + (D.page.title || "web").slice(0, 40);
root.resize(Math.max(D.page.w, 100), Math.max(D.page.h, 100));
root.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
figma.currentPage.appendChild(root);
root.x = figma.viewport.center.x; root.y = figma.viewport.center.y;

const hashes = {};
for (const src in D.imgs) {
  try { hashes[src] = figma.createImage(figma.base64Decode(D.imgs[src])).hash; } catch (e) {}
}

let made = 0;
for (const e of D.els) {
  if (e.depth === 0) continue; // body → сам root
  try {
    if (e.text) {
      const t = figma.createText();
      t.fontName = { family: "Inter", style: e.fwBold ? "Bold" : "Regular" };
      t.characters = e.text;
      t.fontSize = Math.max(4, e.fs || 14);
      if (e.lh) t.lineHeight = { value: e.lh, unit: "PIXELS" };
      if (e.color) { const c = e.color; t.fills = [{ type: "SOLID", color: rgbv(c), opacity: alp(c) }]; }
      if (e.align === "center") t.textAlignHorizontal = "CENTER";
      else if (e.align === "right") t.textAlignHorizontal = "RIGHT";
      t.textAutoResize = "HEIGHT";
      root.appendChild(t);
      t.x = e.x; t.y = e.y; t.resize(Math.max(e.w, 10), t.height);
      t.name = e.text.slice(0, 24);
      made++;
    }
    if (e.bg || e.src || e.bw) {
      const r = figma.createRectangle();
      r.resize(Math.max(e.w, 1), Math.max(e.h, 1));
      const fills = [];
      if (e.bg) fills.push({ type: "SOLID", color: rgbv(e.bg), opacity: alp(e.bg) });
      if (e.src && hashes[e.src]) fills.push({ type: "IMAGE", imageHash: hashes[e.src], scaleMode: "FILL" });
      r.fills = fills;
      if (e.radius) r.cornerRadius = Math.min(e.radius, Math.min(e.w, e.h) / 2);
      if (e.bw && e.bc) { r.strokes = [{ type: "SOLID", color: rgbv(e.bc), opacity: alp(e.bc) }]; r.strokeWeight = e.bw; }
      r.name = e.src ? "image" : (e.tag === "button" || e.tag === "a" ? "btn-bg" : "bg");
      root.appendChild(r);
      r.x = e.x; r.y = e.y;
      // тексти поверх плашок: плашку під низ її z-сусідів цього ж рівня
      if (e.text) root.insertChild(root.children.length - 2 >= 0 ? root.children.length - 2 : 0, r);
      made++;
    }
  } catch (err) { /* один елемент не критичний */ }
}
function rgbv(css) { const m = css.match(/[\\d.]+/g); return { r: +m[0] / 255, g: +m[1] / 255, b: +m[2] / 255 }; }
function alp(css) { const m = css.match(/[\\d.]+/g); return m[3] !== undefined ? +m[3] : 1; }
figma.viewport.scrollAndZoomIntoView([root]);
figma.notify("Imported: " + made + " layers. Next: Clean → ⇥ 🎨 T");
return { frame: root.id, layers: made, title: D.page.title };
"""
    build = build.replace("%PAYLOAD%", payload)
    # rgbv/alp мають бути оголошені до використання — function declarations hoisted, ок

    req = urllib.request.Request(
        f"http://localhost:{args.port}/exec", data=json.dumps({"code": build, "timeout": 120}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=130) as r:
        resp = json.loads(r.read())
    if not resp.get("ok"):
        print(f"[import] ERROR: {resp.get('error')}", file=sys.stderr)
        if resp.get("hint"):
            print(f"   hint: {resp['hint']}", file=sys.stderr)
        sys.exit(1)
    v = resp.get("value") or {}
    # one line: the bridge relays the last line of output into the panel chat
    print(f"[import] done: {v.get('layers')} layers → frame {v.get('frame')} «{v.get('title') or ''}»", flush=True)


if __name__ == "__main__":
    main()
