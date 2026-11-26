import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import os from "node:os";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { contrastRatio } from "./colors.mjs";
import { evaluate, runAnalyzer } from "./evaluate.mjs";

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
// Which palette slugs the footer uses for its background and its links, read from the
// footer group's block attributes (falling back to the global link colour / page base).
function footerColourSlugs(themeDir, json) {
  const file = path.join(themeDir, "parts", "footer.html");
  if (!fs.existsSync(file)) return { error: "parts/footer.html missing" };
  const m = /<!--\s*wp:group\s+(\{[\s\S]*?\})\s*-->/.exec(fs.readFileSync(file, "utf8"));
  let attrs = {};
  if (m) {
    try { attrs = JSON.parse(m[1]); } catch { return { error: "cannot parse the footer group's block attributes" }; }
  }
  // "var:preset|color|slug" or "var(--wp--preset--color--slug)"
  const slugFrom = (v) =>
    typeof v === "string" ? (/\|color\|([a-z0-9-]+)$/i.exec(v) ?? /--color--([a-z0-9-]+)\)$/i.exec(v))?.[1] : undefined;
  const link =
    slugFrom(attrs.style?.elements?.link?.color?.text) ??
    slugFrom(json.styles?.elements?.link?.color?.text) ??
    "primary";
  return { bg: attrs.backgroundColor ?? "base", link };
}

function checkPaletteContrast(parsed, themeDir) {
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
  // Footer links sit on the footer's own background, not on base.
  const footer = footerColourSlugs(themeDir, parsed.json);
  if (footer.error) return fail(id, name, footer.error);
  for (const slug of [footer.bg, footer.link]) {
    if (!p[slug]) return fail(id, name, `footer uses palette colour "${slug}" which is not in the palette`);
  }
  pairs.push([`footer link (${footer.link}) on footer background (${footer.bg})`, p[footer.link], p[footer.bg], 4.5]);

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
    checkPaletteContrast(parsed, themeDir),
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

// ---- WordPress checks (Playground) ------------------------------------------
const PLAYGROUND = "npx --yes @wp-playground/cli@latest";
const ACTIVATION_TIMEOUT_MS = 120_000;
const SERVER_START_TIMEOUT_MS = 120_000;
const SCORE_MIN = 90;

const q = (s) => `"${s}"`; // args go through the shell on Windows (npx is a .cmd file)

function startPlayground(args, logFile) {
  // Output goes to a file, not a pipe: nothing can block on a full pipe while we wait.
  const fd = fs.openSync(logFile, "w");
  const child = spawn(`${PLAYGROUND} ${args.join(" ")}`, {
    shell: true,
    stdio: ["ignore", fd, fd],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  fs.closeSync(fd);
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited };
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch { /* already gone */ }
}

const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// 5: the theme activates in a headless WordPress with no PHP warnings or errors
async function checkActivation(themeDir, slug) {
  const id = 5, name = "activation";
  if (!SLUG_RE.test(slug)) return fail(id, name, `bad slug "${slug}"`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "validate-activation-"));
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(outDir);
  const logFile = path.join(tmp, "playground.log");

  // Two requests, like a real site: (1) activate the theme; (2) boot WordPress again with the theme
  // active, so its functions.php and theme.json really load, and record every PHP error. The error
  // handler is installed before wp-load.php; Playground's own wp-config.php notice is ignored.
  const activatePhp = `<?php
require_once '/wordpress/wp-load.php';
switch_theme('${slug}');
`;
  const inspectPhp = `<?php
error_reporting(E_ALL); ini_set('display_errors', '1');
$log = []; $fin = false;
set_error_handler(function ($no, $str, $file, $line) use (&$log) {
  if (substr($file, -13) === 'wp-config.php') return true;
  $log[] = "PHP error $no: $str in $file:$line"; return true;
});
register_shutdown_function(function () use (&$log, &$fin) {
  if ($fin) return;
  $e = error_get_last();
  $log[] = 'FATAL: ' . ($e ? $e['message'] . ' in ' . $e['file'] . ':' . $e['line'] : 'script stopped early');
  file_put_contents('/out/result.json', json_encode(['done' => false, 'log' => $log]));
});
require_once '/wordpress/wp-load.php';
$t = wp_get_theme();
$err = $t->errors();
$css = strlen(wp_get_global_stylesheet());
$set = wp_get_global_settings();
$r = ['done' => true, 'active' => get_stylesheet(), 'name' => $t->get('Name'), 'block' => wp_is_block_theme(),
  'theme_errors' => is_wp_error($err) ? $err->get_error_message() : null, 'css_bytes' => $css,
  'palette_count' => count($set['color']['palette']['theme'] ?? []), 'log' => $log];
$fin = true;
echo json_encode($r);
file_put_contents('/out/result.json', json_encode($r));
`;
  const blueprint = path.join(tmp, "blueprint.json");
  fs.writeFileSync(
    blueprint,
    JSON.stringify({ steps: [{ step: "runPHP", code: activatePhp }, { step: "runPHP", code: inspectPhp }] })
  );

  const { child, exited } = startPlayground(
    [
      "run-blueprint",
      `--blueprint=${q(blueprint)}`,
      "--mount-dir", q(path.resolve(themeDir)), q(`/wordpress/wp-content/themes/${slug}`),
      "--mount-dir", q(outDir), q("/out"),
    ],
    logFile
  );
  try {
    const code = await Promise.race([exited, sleep(ACTIVATION_TIMEOUT_MS).then(() => "TIMEOUT")]);
    const output = readLog(logFile);
    if (code === "TIMEOUT") return fail(id, name, `TIMEOUT after ${ACTIVATION_TIMEOUT_MS / 1000}s. Output: ${output.trim().slice(-400)}`);

    const resultFile = path.join(outDir, "result.json");
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch { /* handled below */ }

    const problems = [];
    if (code !== 0) problems.push(`Playground exited with code ${code}`);
    const bad = output.split(/\r?\n/).filter((l) => /(Fatal error|Parse error|Warning:|Notice:|Deprecated:|Uncaught|PHP \w+:)/i.test(l));
    problems.push(...bad.map((l) => l.trim()));
    if (!result) problems.push("no result from WordPress (the activation script did not finish)");
    else {
      if (!result.done) problems.push("activation script died");
      problems.push(...(result.log ?? []));
      if (result.done && result.active !== slug) problems.push(`active theme is "${result.active}", expected "${slug}"`);
      if (result.done && result.theme_errors) problems.push(`theme errors: ${result.theme_errors}`);
      if (result.done && !result.block) problems.push("WordPress does not treat this as a block theme");
    }
    if (problems.length) {
      const extra = result ? "" : ` Output: ${output.trim().slice(-300)}`;
      return fail(id, name, problems.slice(0, 5).join(" | ") + extra);
    }
    return ok(id, name, `activated "${result.name}" (block theme), global styles ${result.css_bytes} bytes, ${result.palette_count} palette colours, no PHP warnings`);
  } finally {
    killTree(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 7: render the front page from a real Playground server and score it
async function checkRenderedScore(themeDir) {
  const id = 7, name = "rendered-score";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "validate-render-"));
  const logFile = path.join(tmp, "server.log");
  let server;
  try {
    const port = await freePort();
    server = startPlayground(
      ["server", `--port=${port}`, `--auto-mount=${q(path.resolve(themeDir))}`],
      logFile
    );

    // wait for the "Ready! WordPress is running on http://127.0.0.1:PORT" line
    let url = null;
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let exitedEarly = false;
    server.exited.then(() => { exitedEarly = true; });
    while (Date.now() < deadline && !exitedEarly) {
      const m = /Ready!.*?(http:\/\/127\.0\.0\.1:\d+)/.exec(readLog(logFile));
      if (m) { url = m[1] + "/"; break; }
      await sleep(500);
    }
    if (!url) return fail(id, name, `server did not start: ${readLog(logFile).trim().slice(-300) || "(no output)"}`);

    // warm up: the first request installs WordPress and redirects
    // Connection errors are retried (server still booting); a real HTTP error such as 500 is
    // final after three tries.
    let status = 0, answered = 0;
    for (let i = 0; i < 60 && status !== 200 && answered < 3; i++) {
      try {
        status = (await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })).status;
        if (status !== 200) answered++;
      } catch { await sleep(1000); }
    }
    if (status !== 200) return fail(id, name, `${url} did not return 200 (last status ${status})`);

    let issues;
    try {
      issues = runAnalyzer(url);
    } catch (e) {
      return fail(id, name, `analyzer failed: ${String(e.message).slice(0, 300)}`);
    }
    const { score, issues: sorted } = evaluate(issues);
    const remaining = sorted.map((i) => i.id).join(", ") || "none";
    const detail = `score ${score}/100 (min ${SCORE_MIN}); remaining issues: ${remaining}`;
    return score >= SCORE_MIN ? ok(id, name, detail) : fail(id, name, detail);
  } finally {
    killTree(server?.child); // always, even on error
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function validateWordPress(themeDir, slug = path.basename(path.resolve(themeDir))) {
  const checks = [await checkActivation(themeDir, slug), await checkRenderedScore(themeDir)];
  return { passed: checks.every((c) => c.passed), checks };
}

export async function validateAll(themeDir, slug = path.basename(path.resolve(themeDir))) {
  const [s, w] = [await validateStatic(themeDir), await validateWordPress(themeDir, slug)];
  const checks = [...s.checks, ...w.checks].sort((a, b) => a.id - b.id);
  return { passed: checks.every((c) => c.passed), checks };
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const themeDir = args.find((a) => !a.startsWith("--"));
  if (!themeDir) {
    console.error("Usage: node validate-theme.mjs <themeDir> [--full]");
    process.exit(1);
  }
  const result = full ? await validateAll(themeDir) : await validateStatic(themeDir);
  console.log(`Validating ${themeDir}`);
  console.log("ID  CHECK             RESULT  DETAIL");
  for (const c of result.checks) {
    console.log(`${String(c.id).padEnd(3)} ${c.name.padEnd(17)} ${(c.passed ? "PASS" : "FAIL").padEnd(7)} ${c.detail}`);
  }
  console.log(result.passed ? "\nAll checks passed." : `\n${result.checks.filter((c) => !c.passed).length} check(s) FAILED.`);
  process.exit(result.passed ? 0 : 1);
}
