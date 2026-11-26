import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { contrastRatio } from "./colors.mjs";

const ok = (id, name, detail) => ({ id, name, passed: true, detail });
const fail = (id, name, detail) => ({ id, name, passed: false, detail });

// 1: the zip has one top-level directory named after the slug, nothing at the root
function checkStructure(themeDir) {
  const id = 1, name = "structure";
  const slug = path.basename(path.resolve(themeDir));
  const zipPath = path.resolve(themeDir) + ".zip";
  if (!fs.existsSync(zipPath)) return fail(id, name, `zip not found: ${zipPath}`);
  let entries;
  try {
    entries = new AdmZip(zipPath).getEntries().map((e) => e.entryName.replace(/\\/g, "/"));
  } catch (e) {
    return fail(id, name, `cannot read zip: ${e.message}`);
  }
  if (!entries.length) return fail(id, name, "zip is empty");
  const rootFiles = entries.filter((e) => !e.includes("/"));
  const topDirs = [...new Set(entries.filter((e) => e.includes("/")).map((e) => e.split("/")[0]))];
  if (rootFiles.length) return fail(id, name, `files at archive root: ${rootFiles.join(", ")}`);
  if (topDirs.length !== 1) return fail(id, name, `expected 1 top-level directory, found ${topDirs.length}: ${topDirs.join(", ")}`);
  if (topDirs[0] !== slug) return fail(id, name, `top-level directory is "${topDirs[0]}", expected "${slug}"`);
  return ok(id, name, `${slug}/ only (${entries.filter((e) => !e.endsWith("/")).length} files)`);
}

// 2: style.css header has a "Theme Name:" field
function checkThemeName(themeDir) {
  const id = 2, name = "theme-name";
  const file = path.join(themeDir, "style.css");
  if (!fs.existsSync(file)) return fail(id, name, "style.css missing");
  const css = fs.readFileSync(file, "utf8");
  const header = /\/\*([\s\S]*?)\*\//.exec(css);
  if (!header) return fail(id, name, "no header comment in style.css");
  const m = /^\s*Theme Name:\s*(.+?)\s*$/im.exec(header[1]);
  if (!m) return fail(id, name, 'no "Theme Name:" field in the header comment');
  return ok(id, name, `"${m[1]}"`);
}

// 3: templates/index.html exists and has content
function checkIndexTemplate(themeDir) {
  const id = 3, name = "index-template";
  const file = path.join(themeDir, "templates", "index.html");
  if (!fs.existsSync(file)) return fail(id, name, "templates/index.html missing");
  const size = fs.statSync(file).size;
  if (!fs.readFileSync(file, "utf8").trim()) return fail(id, name, "templates/index.html is empty");
  return ok(id, name, `${size} bytes`);
}

// 4: theme.json parses and has a version
function readThemeJson(themeDir) {
  const file = path.join(themeDir, "theme.json");
  if (!fs.existsSync(file)) return { error: "theme.json missing" };
  try {
    return { json: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { error: `JSON parse error: ${e.message}` };
  }
}

function checkThemeJson(themeDir, parsed) {
  const id = 4, name = "theme-json";
  if (parsed.error) return fail(id, name, parsed.error);
  if (parsed.json.version === undefined) return fail(id, name, 'parses, but has no "version" field');
  return ok(id, name, `valid JSON, version ${parsed.json.version}`);
}

// 6: every text/background pair the theme uses meets its minimum ratio
function checkPaletteContrast(parsed) {
  const id = 6, name = "palette-contrast";
  if (parsed.error) return fail(id, name, `cannot read palette: ${parsed.error}`);
  const palette = parsed.json.settings?.color?.palette;
  if (!Array.isArray(palette)) return fail(id, name, "settings.color.palette missing");
  const p = Object.fromEntries(palette.map((c) => [c.slug, c.color]));
  const missing = ["base", "contrast", "accent", "primary", "secondary"].filter((s) => !p[s]);
  if (missing.length) return fail(id, name, `palette lacks: ${missing.join(", ")}`);

  // Contrast is symmetric, so each pair below is a genuinely different colour combination.
  const pairs = [
    ["contrast on base", p.contrast, p.base, 4.5],
    ["contrast on accent", p.contrast, p.accent, 4.5],
    ["primary on base (links)", p.primary, p.base, 4.5],
    ["secondary on base (muted text)", p.secondary, p.base, 4.5],
    ["primary on accent (UI, 1.4.11)", p.primary, p.accent, 3.0],
  ];
  const rows = pairs.map(([label, fg, bg, min]) => {
    const ratio = contrastRatio(fg, bg);
    return { label, ratio, min, passed: ratio >= min };
  });
  const detail = rows.map((r) => `${r.label} ${r.ratio.toFixed(2)}${r.passed ? "" : " (<" + r.min + ")"}`).join("; ");
  return rows.every((r) => r.passed) ? ok(id, name, detail) : fail(id, name, detail);
}

export async function validateStatic(themeDir) {
  const parsed = readThemeJson(themeDir);
  const checks = [
    checkStructure(themeDir),
    checkThemeName(themeDir),
    checkIndexTemplate(themeDir),
    checkThemeJson(themeDir, parsed),
    checkPaletteContrast(parsed),
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const themeDir = process.argv[2];
  if (!themeDir) {
    console.error("Usage: node validate-theme.mjs <themeDir>");
    process.exit(1);
  }
  const result = await validateStatic(themeDir);
  console.log(`Validating ${themeDir}`);
  console.log("ID  CHECK             RESULT  DETAIL");
  for (const c of result.checks) {
    console.log(`${String(c.id).padEnd(3)} ${c.name.padEnd(17)} ${(c.passed ? "PASS" : "FAIL").padEnd(7)} ${c.detail}`);
  }
  console.log(result.passed ? "\nAll checks passed." : `\n${result.checks.filter((c) => !c.passed).length} check(s) FAILED.`);
  process.exit(result.passed ? 0 : 1);
}
