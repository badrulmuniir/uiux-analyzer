// End-to-end journey:
//   accessibility pipeline (Agents 1-4) -> preview -> brand colour -> theme -> zip -> validation -> content preview
// Agent 5 (theme + content) consumes the pipeline's FIXED output in candidate/. If the pipeline was
// rejected or produced nothing, it falls back to the original and says so.
// Usage: node e2e.mjs [folder] [entry]      (default: testing1/ demo-site.html)
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "./pipeline.mjs";
import { evaluate, runAnalyzer } from "./evaluate.mjs";
import { screenshot } from "./preview.mjs";
import { extractBrandColors } from "./colors.mjs";
import { generateTheme, zipTheme } from "./themegen.mjs";
import { formatReport } from "./structure.mjs";
import { generateAdaptiveTheme } from "./templategen.mjs";
import { validateAll } from "./validate-theme.mjs";
import { previewWithContent } from "./content-import.mjs";
import { serveAll, printRows } from "./serve-all.mjs";

// Arguments: [folder] [entry]  or a single path to the html file; flag --preset = legacy Agent 5 v1.
const argv = process.argv.slice(2);
const PRESET = argv.includes("--preset"); // default (no flag) = Agent 5 v2, adaptive
const positional = argv.filter((a) => !a.startsWith("--"));
let folder = positional[0] || "testing1/";
let entry = positional[1] || "demo-site.html";
if (positional[0] && !positional[1] && fs.existsSync(positional[0]) && fs.statSync(positional[0]).isFile()) {
  folder = path.dirname(positional[0]); // a single html file was given
  entry = path.basename(positional[0]);
}
const STYLE = "modern";
const SLUG = PRESET ? "modern-brand" : "adaptive-demo";
const MODE = PRESET ? "preset (v1, --preset)" : "adaptive (v2, default)";
const OUT_DIR = path.resolve("generated");
console.log(`Agent 5 mode: ${MODE}${PRESET ? "" : "  [structure.mjs + templategen.mjs; pass --preset for the legacy themegen.mjs template]"}`);

const results = {}; // summary line per step
const failures = [];
const step = async (n, title, fn) => {
  console.log(`\n=== Step ${n}: ${title} ===`);
  try {
    await fn();
  } catch (e) {
    failures.push(`step ${n} (${title}): ${e.message}`);
    console.log(`  FAILED: ${e.message}`);
  }
};
const ids = (issues) => [...new Set(issues.map((i) => i.id))];
const pngSize = (p) => {
  const b = fs.readFileSync(p);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}px`;
};

// Where Agent 5 reads from. Set after the pipeline: candidate/ only when THIS run's pipeline was
// accepted (candidate/ persists between runs, so an old one must never be trusted).
let pipelineAccepted = false;
let validationPassed = false;
let scoreBeforeVal;
let scoreAfterVal;
let issuesFound = 0;
let source = { dir: folder, entry, label: "original", fixed: false };

let brandCss = "";
let themeResult = null;
let brand = null;

// 1 ---------------------------------------------------------------------------
await step(1, "input", async () => {
  const input = path.resolve(folder, entry);
  if (!fs.existsSync(input)) throw new Error(`input not found: ${input}`);
  console.log(`  input: ${input}`);
});

// 2 ---------------------------------------------------------------------------
await step(2, "accessibility pipeline (Agents 1-4)", async () => {
  const s = await pipeline.invoke({ dir: folder, entry });
  scoreBeforeVal = s.scoreBefore;
  scoreAfterVal = s.scoreAfter ?? s.scoreBefore;
  const before = ids(s.issues);
  issuesFound = before.length;
  const scoreAfter = s.scoreAfter ?? s.scoreBefore; // null when there was nothing to fix
  let remaining = [];
  if (fs.existsSync(path.join("candidate", s.entry))) {
    remaining = ids(evaluate(runAnalyzer(path.join("candidate", s.entry))).issues);
  } else if (!s.accepted) {
    remaining = before;
  }
  const fixed = before.filter((id) => !remaining.includes(id));

  console.log(`  scoreBefore: ${s.scoreBefore}`);
  console.log(`  scoreAfter:  ${scoreAfter}`);
  console.log(`  accepted:    ${s.accepted}`);
  console.log(`  attempts:    ${s.attempts}`);
  console.log(`  issues fixed (${fixed.length}):     ${fixed.join(", ") || "none"}`);
  console.log(`  issues remaining (${remaining.length}): ${remaining.join(", ") || "none"}`);

  results.fix = `${s.scoreBefore} -> ${scoreAfter} (${s.accepted ? "accepted" : "REJECTED"}, ${s.attempts} attempt${s.attempts === 1 ? "" : "s"})`;
  if (!s.accepted) throw new Error("the pipeline did not accept a fix");
  pipelineAccepted = true;
});

// choose the source for everything Agent 5 does ----------------------------------
const candidateFile = path.resolve("candidate", entry);
if (pipelineAccepted && issuesFound > 0 && fs.existsSync(candidateFile)) {
  source = { dir: "candidate", entry, label: "candidate/ (fixed)", fixed: true };
} else if (pipelineAccepted && issuesFound === 0) {
  source = { dir: folder, entry, label: "original (nothing needed fixing)", fixed: false };
} else {
  const why = !pipelineAccepted ? "the pipeline did not succeed in this run" : "the pipeline produced no candidate file";
  source = { dir: folder, entry, label: "original (FIXES NOT APPLIED)", fixed: false };
  console.log("\n  ****************************************************************");
  console.log(`  WARNING: ${why}.`);
  console.log("  The accessibility fixes were NOT applied: the brand colour, theme and");
  console.log("  content preview below use the ORIGINAL site, not a fixed version.");
  console.log("  ****************************************************************");
}
console.log(`\n  Agent 5 source: ${source.label}  (${path.join(source.dir, source.entry)})`);

// 3 ---------------------------------------------------------------------------
await step(3, "before/after preview screenshots", async () => {
  const before = path.join("previews", "before.png");
  const after = path.join("previews", "after.png");
  await screenshot(folder, entry, before);
  console.log(`  before: ${path.resolve(before)} (${pngSize(before)})  [original]`);
  if (!source.fixed) {
    results.preview = "before.png only (no fixed version to compare)";
    console.log("  after:  skipped, no fixed candidate from this run");
    return;
  }
  await screenshot("candidate", entry, after);
  console.log(`  after:  ${path.resolve(after)} (${pngSize(after)})  [candidate/]`);
  results.preview = "before.png, after.png";
});

// 4 ---------------------------------------------------------------------------
await step(4, `brand colour from ${source.label}`, async () => {
  // every html/css file of the chosen source (inline <style> and style="" are in the html)
  const root = path.resolve(source.dir);
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : /\.(html?|css)$/i.test(e.name) ? [p] : [];
    });
  const files = walk(root);
  brandCss = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  brand = extractBrandColors(brandCss);
  console.log(`  source: ${source.label}`);
  console.log(`  scanned ${files.length} file(s), ${brandCss.length} chars`);
  console.log(`  brand colour found: ${brand ?? "none (the preset palette will be used)"}`);
});

// 5 ---------------------------------------------------------------------------
await step(5, PRESET ? `generate theme (preset ${STYLE}, brand colour)` : `generate adaptive theme (structure.mjs + templategen.mjs, brand colour)`, async () => {
  let sectionsNote = "";
  if (PRESET) {
    themeResult = generateTheme(STYLE, { slug: SLUG, name: "Modern Brand", colorMode: "brand", brandCss }, OUT_DIR);
  } else {
    // detect the sections of the SOURCE page (fixed candidate/ when available) and rebuild them as blocks
    const htmlPath = path.join(source.dir, source.entry);
    console.log(`  detecting structure of: ${path.resolve(htmlPath)}`);
    themeResult = await generateAdaptiveTheme(htmlPath, path.join(OUT_DIR, SLUG), { brandCss });
    console.log("  detected sections:");
    for (const line of formatReport(themeResult.sections).split("\n").filter((l) => /^\s*\d+\. /.test(l))) console.log("    " + line.trim());
    console.log(`  front page: ${themeResult.frontPage}`);
    if (themeResult.notes.generatedNames.length) console.log(`  form field names generated (source had none): ${themeResult.notes.generatedNames.join("; ")}`);
    sectionsNote = `, ${themeResult.sections.length} sections`;
  }
  const pal = themeResult.colors;
  console.log("  final palette:");
  for (const [k, v] of Object.entries(pal)) console.log(`    ${k.padEnd(16)} ${v}`);
  const adjusted = brand && pal.primary !== brand;
  console.log(`  primary auto-adjusted: ${adjusted ? `yes, ${brand} -> ${pal.primary} for contrast` : "no"}`);
  console.log(`  footer link colour:    ${pal["primary-on-dark"]}${pal["primary-on-dark"] !== pal.primary ? ` (primary ${pal.primary} lightened to pass 4.5:1 on the dark footer)` : " (same as primary)"}`);
  results.brand = brand ? `${brand}${adjusted ? ` (adjusted to ${pal.primary})` : " (no adjustment needed)"}` : "none found, preset palette used";
  results.theme = `${SLUG}, ${themeResult.files.length} files${sectionsNote}`;
});

// 6 (zip first: validation check 1 reads it) -----------------------------------------
let zipPath = path.join(OUT_DIR, `${SLUG}.zip`);
await step(6, "theme zip", async () => {
  if (!themeResult) throw new Error("no theme was generated");
  zipPath = await zipTheme(SLUG, OUT_DIR);
  const size = fs.statSync(zipPath).size;
  console.log(`  ${zipPath} (${(size / 1024).toFixed(1)} KB)`);
  results.download = `generated/${SLUG}.zip (${Math.round(size / 1024)} KB)`;
});

// 7 ---------------------------------------------------------------------------
await step(7, "validation (all 7 checks, live WordPress Playground)", async () => {
  if (!themeResult) throw new Error("no theme was generated");
  const v = await validateAll(themeResult.dir, SLUG);
  for (const c of v.checks) {
    console.log(`  ${c.id} ${c.name.padEnd(17)} ${c.passed ? "PASS" : "FAIL"}  ${c.detail}`);
  }
  const passed = v.checks.filter((c) => c.passed).length;
  results.validation = `${passed}/${v.checks.length} passed`;
  validationPassed = v.passed;
  if (!v.passed) throw new Error(`${v.checks.length - passed} validation check(s) failed`);
});

// 8 ---------------------------------------------------------------------------
await step(8, `content preview from ${source.label}`, async () => {
  if (!themeResult) throw new Error("no theme was generated");
  const htmlPath = path.join(source.dir, source.entry);
  console.log(`  importing content from: ${path.resolve(htmlPath)}`);
  const out = path.join("previews", `${SLUG}-content.png`);
  const r = await previewWithContent(htmlPath, themeResult.dir, SLUG, out);
  const i = r.imported;
  console.log(`  site title: ${i.siteTitle}`);
  console.log(`  tagline:    ${i.tagline ?? "(none)"}`);
  console.log(`  imported:   ${i.pages} pages, ${i.posts} posts, ${i.navItems} nav items`);
  console.log(`  screenshot: ${r.png} (${pngSize(r.png)})`);
  results.content = `${i.pages} pages, ${i.posts} posts, ${i.navItems} nav items -> previews/${SLUG}-content.png`;
});

// summary ---------------------------------------------------------------------
const row = (label, value, src) =>
  console.log(`  ${(label + ":").padEnd(20)}${(value ?? "(not reached)").padEnd(66)}${src ? `[source: ${src}]` : ""}`);
console.log("\n=== Summary ===");
row("Agent 5 mode", MODE);
row("Accessibility fix", results.fix, `original -> ${source.fixed ? "candidate/" : "no fixed output"}`);
row("Preview", results.preview, source.fixed ? "original + candidate/" : "original");
row("Brand colour", results.brand, source.label);
row("Theme generated", results.theme, PRESET ? `preset template, colour from ${source.label}` : `sections + colour from ${source.label}`);
row("Content preview", results.content, source.label);
row("Validation", results.validation);
row("Download ready", results.download);
if (!source.fixed && issuesFound !== 0 || !pipelineAccepted) {
  console.log("\n  NOTE: the accessibility fixes are NOT reflected in the theme or its preview (see warning above).");
}
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  failures.forEach((f) => console.log("  - " + f));
} else {
  console.log("\nAll steps passed.");
}
const exitCode = failures.length ? 1 : 0;

// Validation passed: start the three live-preview servers (same as serve-all.mjs) for the theme just
// generated, and keep them running until Ctrl+C. --no-serve skips this (CI, scripts).
if (validationPassed && themeResult && !argv.includes("--no-serve")) {
  console.log("\n=== Live preview ===");
  console.log("Validation passed, starting the preview servers (pass --no-serve to skip)...");
  let running = null;
  let stopping = false;
  const shutdown = async (code) => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping all servers...");
    await running?.stop();
    console.log("All servers stopped.");
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(exitCode));
  process.on("SIGTERM", () => shutdown(exitCode));
  try {
    running = await serveAll({
      folder,
      entry,
      themeDir: themeResult.dir,
      slug: SLUG,
      contentFile: path.join(source.dir, source.entry),
      fixedFresh: source.fixed, // only serve candidate/ when this run produced it
      scoreOriginal: scoreBeforeVal,
      scoreFixed: source.fixed ? scoreAfterVal : undefined,
    });
    printRows(running.rows);
    if (!source.fixed) console.log("\n  (no fixed page from this run, so only the original and the theme are served)");
    console.log("\nAll servers are running. Press Ctrl+C to stop them.");
    await new Promise(() => {}); // stay alive; the signal handlers end the process
  } catch (e) {
    console.error("could not start the preview servers:", e.message);
    await shutdown(1);
  }
}
process.exit(exitCode);
