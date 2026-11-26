import { fileURLToPath } from "node:url";
import path from "node:path";

// ---- hex / rgb / hsl helpers ---------------------------------------------
export function normalizeHex(hex) {
  let h = String(hex).trim().toLowerCase().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join("");
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (!/^[0-9a-f]{6}$/.test(h)) throw new Error(`invalid hex colour: ${hex}`);
  return "#" + h;
}

const hexToRgb = (hex) => {
  const h = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const rgbToHex = (rgb) =>
  "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hexToHsl = (hex) => rgbToHsl(hexToRgb(hex));
const hslToHex = (hsl) => rgbToHex(hslToRgb(hsl));

function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v * (1 - t) + b[i] * t));
}

// ---- WCAG contrast ---------------------------------------------------------
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hex1, hex2) {
  const [hi, lo] = [luminance(hex1), luminance(hex2)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Keep hue and saturation, move lightness (1% steps) away from the background
 * until the pair reaches minRatio.
 * Returns { color, changed, originalColor, ratio }.
 */
export function ensureContrast(fgHex, bgHex, minRatio = 4.5) {
  const originalColor = normalizeHex(fgHex);
  const bg = normalizeHex(bgHex);
  let ratio = contrastRatio(originalColor, bg);
  if (ratio >= minRatio) return { color: originalColor, changed: false, originalColor, ratio };

  // Go toward whichever extreme (black or white) contrasts more with the background.
  const darken = contrastRatio(bg, "#000000") >= contrastRatio(bg, "#ffffff");
  const [h, s, l0] = hexToHsl(originalColor);
  let color = originalColor;
  for (let l = l0; darken ? l >= 0 : l <= 1; l += darken ? -0.01 : 0.01) {
    color = hslToHex([h, s, Math.min(1, Math.max(0, l))]);
    ratio = contrastRatio(color, bg);
    if (ratio >= minRatio) break;
  }
  return { color, changed: color !== originalColor, originalColor, ratio };
}

// ---- palettes --------------------------------------------------------------
// Fixed neutrals per style; only primary/accent follow the chosen colour.
const NEUTRALS = {
  modern: { dark: false, base: "#ffffff", contrast: "#0f172a", secondary: "#475569" },
  minimal: { dark: false, base: "#ffffff", contrast: "#171717", secondary: "#737373" },
  bold: { dark: true, base: "#0f172a", contrast: "#ffffff", secondary: "#94a3b8", accentBase: "#1e293b" },
};

/**
 * One brand colour + style name -> full 5-colour palette.
 * Pass an array as `report` to receive { role, from, to, against } for every
 * colour that had to be adjusted for contrast.
 */
export function derivePalette(primaryHex, styleName, report = []) {
  const n = NEUTRALS[styleName];
  if (!n) throw new Error(`unknown style "${styleName}"`);
  const given = normalizeHex(primaryHex);
  const [h, s] = hexToHsl(given);

  // light styles: ~96% lightness tint of the brand hue; bold: dark tint a little lighter than base
  const accent = n.dark ? mix(n.accentBase, given, 0.1) : hslToHex([h, Math.min(s, 0.9), 0.96]);

  // primary is used as text/links on base and on accent surfaces, and as a button
  // background under base-coloured text, so it has to pass against both.
  let primary = given;
  for (const against of [n.base, accent]) primary = ensureContrast(primary, against, 4.5).color;
  if (primary !== given) report.push({ role: "primary", from: given, to: primary, dark: n.dark });

  const secondary = ensureContrast(n.secondary, n.base, 4.5).color;
  return { base: n.base, contrast: n.contrast, primary, secondary, accent };
}

// ---- brand colour extraction ----------------------------------------------
/** Most frequent non-grey colour in a CSS string, as #rrggbb, or null. */
export function extractBrandColors(cssText) {
  if (!cssText) return null;
  const counts = new Map();
  const add = (hex) => counts.set(hex, (counts.get(hex) ?? 0) + 1);

  for (const m of cssText.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi)) {
    try { add(normalizeHex(m[0])); } catch { /* not a colour */ }
  }
  for (const m of cssText.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    const rgb = [m[1], m[2], m[3]].map(Number);
    if (rgb.every((v) => v <= 255)) add(rgbToHex(rgb));
  }

  const candidates = [...counts].filter(([hex]) => {
    const [, sat, l] = hexToHsl(hex);
    return sat >= 0.15 && l > 0.05 && l < 0.95; // drops white, black, greys, near-white/black tints
  });
  if (!candidates.length) return null;
  // most frequent; ties go to the more saturated colour
  candidates.sort((a, b) => b[1] - a[1] || hexToHsl(b[0])[1] - hexToHsl(a[0])[1]);
  return candidates[0][0];
}

// ---- unit checks: node colors.mjs -----------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: assert } = await import("node:assert/strict");
  let passed = 0;
  const test = (name, fn) => {
    try {
      fn();
      passed++;
      console.log("  ok   " + name);
    } catch (e) {
      console.log("  FAIL " + name + "\n       " + e.message.split("\n")[0]);
      process.exitCode = 1;
    }
  };

  console.log("contrastRatio");
  test("white on black is 21", () => assert.equal(Math.round(contrastRatio("#ffffff", "#000000") * 100) / 100, 21));
  test("same colour is 1", () => assert.equal(contrastRatio("#336699", "#336699"), 1));
  test("is symmetric", () => assert.equal(contrastRatio("#2563eb", "#fff"), contrastRatio("#fff", "#2563eb")));

  console.log("ensureContrast");
  test("passing colour is unchanged", () => {
    const r = ensureContrast("#2563eb", "#ffffff");
    assert.equal(r.changed, false);
    assert.equal(r.color, "#2563eb");
  });
  test("failing light colour darkens until it passes 4.5", () => {
    const r = ensureContrast("#6699cc", "#ffffff");
    assert.equal(r.changed, true);
    assert.ok(r.ratio >= 4.5, `ratio ${r.ratio}`);
    assert.equal(r.originalColor, "#6699cc");
    assert.ok(hexToHsl(r.color)[2] < hexToHsl("#6699cc")[2], "lightness should drop");
    console.log(`       #6699cc -> ${r.color} (${r.ratio.toFixed(2)}:1)`);
  });
  test("keeps hue and saturation", () => {
    const [h1, s1] = hexToHsl("#6699cc");
    const [h2, s2] = hexToHsl(ensureContrast("#6699cc", "#ffffff").color);
    assert.ok(Math.abs(h1 - h2) < 3 && Math.abs(s1 - s2) < 0.05, `hue ${h1}->${h2}, sat ${s1}->${s2}`);
  });
  test("on a dark background it lightens", () => {
    const r = ensureContrast("#334155", "#0f172a");
    assert.equal(r.changed, true);
    assert.ok(r.ratio >= 4.5);
    assert.ok(hexToHsl(r.color)[2] > hexToHsl("#334155")[2], "lightness should rise");
  });
  test("honours a custom minRatio", () => {
    const r = ensureContrast("#2563eb", "#ffffff", 7);
    assert.ok(r.changed && r.ratio >= 7);
  });

  console.log("derivePalette");
  for (const style of ["modern", "minimal", "bold"]) {
    test(`${style}: primary passes 4.5 on base and accent`, () => {
      const p = derivePalette("#ff9900", style);
      assert.ok(contrastRatio(p.primary, p.base) >= 4.5, `base ${contrastRatio(p.primary, p.base)}`);
      assert.ok(contrastRatio(p.primary, p.accent) >= 4.5, `accent ${contrastRatio(p.primary, p.accent)}`);
      assert.deepEqual(Object.keys(p).sort(), ["accent", "base", "contrast", "primary", "secondary"]);
    });
  }
  test("light style: base stays white, accent is a very light tint", () => {
    const p = derivePalette("#2563eb", "modern");
    assert.equal(p.base, "#ffffff");
    assert.ok(hexToHsl(p.accent)[2] > 0.94 && hexToHsl(p.accent)[2] < 0.98);
    assert.equal(p.primary, "#2563eb");
  });
  test("bold: base stays dark, contrast stays white, accent lighter than base", () => {
    const p = derivePalette("#a78bfa", "bold");
    assert.equal(p.base, "#0f172a");
    assert.equal(p.contrast, "#ffffff");
    assert.ok(luminance(p.accent) > luminance(p.base));
  });
  test("bold lightens a dark brand colour", () => {
    const report = [];
    const p = derivePalette("#1d4ed8", "bold", report);
    assert.ok(report.length > 0 && contrastRatio(p.primary, p.base) >= 4.5);
  });

  console.log("extractBrandColors");
  test("picks the most frequent non-grey colour", () => {
    const css = `a{color:#e11d48} b{color:#E11D48} c{background:rgb(225,29,72)} d{color:#2563eb} body{color:#111;background:#fff;border:1px solid #ccc}`;
    assert.equal(extractBrandColors(css), "#e11d48");
  });
  test("ignores white, black and greys", () => {
    assert.equal(extractBrandColors("a{color:#fff;background:#000;border-color:#888888;x:rgb(120,120,120)}"), null);
  });
  test("expands 3-digit hex", () => assert.equal(extractBrandColors("a{color:#f00} b{color:#f00}"), "#ff0000"));
  test("returns null for empty input", () => assert.equal(extractBrandColors(""), null));

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ", 0 failed"}`);
}
