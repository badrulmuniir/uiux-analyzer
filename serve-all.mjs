// Live preview of every output: original site, fixed site, generated theme.
// Usage: node serve-all.mjs [folder] [entry] [--theme=generated/adaptive-demo] [--slug=adaptive-demo]
//   Default theme: generated/adaptive-demo (Agent 5 v2). For the legacy preset theme: --theme=generated/modern-brand
//   ORIGINAL  static server on <folder>
//   FIXED     static server on candidate/
//   THEME     Playground with the theme and the content imported from candidate/<entry>
// All three keep running until Ctrl+C.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, runAnalyzer } from "./evaluate.mjs";
import { startContentServer } from "./content-import.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

// Plain static file server on 127.0.0.1 with a free port. Cannot read outside `root`.
function serveStatic(root, defaultEntry) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); }
    catch { res.writeHead(400).end("Bad request"); return; }
    if (pathname === "/") pathname = "/" + defaultEntry;
    const file = path.resolve(base, "." + pathname);
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end("Forbidden"); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
const score = (file) => {
  try { return evaluate(runAnalyzer(file)).score; } catch { return null; }
};


// Start the three servers and return { rows, stop }. The caller owns Ctrl+C handling (see below
// and e2e.mjs). Throws, after stopping anything already started, if something cannot start.
//   fixedFresh=false: candidate/ is not trusted (e.g. the pipeline did not run), so the FIXED server is skipped.
export async function serveAll({
  folder = "testing1/", entry = "demo-site.html", themeDir, slug, contentFile,
  fixedDir = "candidate", scoreOriginal, scoreFixed, fixedFresh = true,
}) {
  slug ||= path.basename(themeDir);
  const originalFile = path.join(folder, entry);
  const fixedFile = path.join(fixedDir, entry);
  const needed = [["original", originalFile], ["theme folder", path.join(themeDir, "theme.json")]];
  if (fixedFresh) needed.push(["fixed (candidate/)", fixedFile]);
  for (const [label, f] of needed) {
    if (!fs.existsSync(f)) {
      throw new Error(`Missing ${label}: ${path.resolve(f)}${label.startsWith("fixed") ? "\n  Run the pipeline first (node e2e.mjs) to produce candidate/." : label === "theme folder" ? "\n  Generate it first (node e2e.mjs)." : ""}`);
    }
  }

  const stops = [];
  const stop = async () => { await Promise.allSettled(stops.map((s) => s())); };
  try {
    if (scoreOriginal === undefined) { console.log("Scoring the original page..."); scoreOriginal = score(originalFile); }
    if (fixedFresh && scoreFixed === undefined) { console.log("Scoring the fixed page..."); scoreFixed = score(fixedFile); }

    const original = await serveStatic(folder, entry);
    stops.push(() => closeServer(original.server));
    let fixed = null;
    if (fixedFresh) {
      fixed = await serveStatic(fixedDir, entry);
      stops.push(() => closeServer(fixed.server));
    }

    console.log("Starting the theme server (WordPress Playground, content imported from the page)...");
    const theme = await startContentServer(contentFile || (fixedFresh ? fixedFile : originalFile), themeDir, slug);
    stops.push(() => theme.stop());

    const sc = (n) => (n === null || n === undefined ? "score n/a" : `score ${n}`);
    const rows = [[`Original (${sc(scoreOriginal)}):`, `http://127.0.0.1:${original.port}/${entry}`]];
    if (fixed) rows.push([`Fixed (${sc(scoreFixed)}):`, `http://127.0.0.1:${fixed.port}/${entry}`]);
    rows.push(["New theme:", theme.url]);
    return { rows, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

export function printRows(rows) {
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  console.log("");
  for (const [label, url] of rows) console.log(`  ${label.padEnd(w)}${url}`);
}

// ---- CLI ---------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
  const [folder = "testing1/", entry = "demo-site.html"] = args.filter((a) => !a.startsWith("--"));
  const themeDir = flags.theme || path.join("generated", "adaptive-demo");

  let running = null;
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping all servers...");
    await running?.stop();
    console.log("All servers stopped.");
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  try {
    running = await serveAll({ folder, entry, themeDir, slug: flags.slug });
    printRows(running.rows);
    console.log("\nAll three are running. Press Ctrl+C to stop them.");
    await new Promise(() => {}); // stay alive; the signal handlers end the process
  } catch (e) {
    console.error("serve-all failed:", e.message);
    await shutdown(1);
  }
}
