// Live preview of every output: original site, fixed site, generated theme.
// Usage: node serve-all.mjs [folder] [entry] [--theme=generated/modern-brand] [--slug=modern-brand]
//   ORIGINAL  static server on <folder>
//   FIXED     static server on candidate/
//   THEME     Playground with the theme and the content imported from candidate/<entry>
// All three keep running until Ctrl+C.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const [folder = "testing1/", entry = "demo-site.html"] = args.filter((a) => !a.startsWith("--"));
const themeDir = flags.theme || path.join("generated", "modern-brand");
const slug = flags.slug || path.basename(themeDir);

const originalFile = path.join(folder, entry);
const fixedFile = path.join("candidate", entry);
for (const [label, f] of [["original", originalFile], ["fixed (candidate/)", fixedFile], ["theme folder", path.join(themeDir, "theme.json")]]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing ${label}: ${path.resolve(f)}${label.startsWith("fixed") ? "\n  Run the pipeline first (node e2e.mjs) to produce candidate/." : label === "theme folder" ? "\n  Generate it first (node e2e.mjs, or node themegen.mjs ...)." : ""}`);
    process.exit(1);
  }
}

const stops = [];
let stopping = false;
const shutdown = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping all servers...");
  await Promise.allSettled(stops.map((s) => s()));
  console.log("All servers stopped.");
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  console.log("Scoring the original and the fixed page...");
  const [scoreOriginal, scoreFixed] = [score(originalFile), score(fixedFile)];

  const original = await serveStatic(folder, entry);
  stops.push(() => closeServer(original.server));
  const fixed = await serveStatic("candidate", entry);
  stops.push(() => closeServer(fixed.server));

  console.log("Starting the theme server (WordPress Playground, content imported from candidate/)...");
  const theme = await startContentServer(fixedFile, themeDir, slug);
  stops.push(() => theme.stop());

  const sc = (n) => (n === null ? "score n/a" : `score ${n}`);
  const rows = [
    [`Original (${sc(scoreOriginal)}):`, `http://127.0.0.1:${original.port}/${entry}`],
    [`Fixed (${sc(scoreFixed)}):`, `http://127.0.0.1:${fixed.port}/${entry}`],
    ["New theme:", theme.url],
  ];
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  console.log("");
  for (const [label, url] of rows) console.log(`  ${label.padEnd(w)}${url}`);
  console.log("\nAll three are running. Press Ctrl+C to stop them.");
  await new Promise(() => {}); // stay alive; the signal handlers end the process
} catch (e) {
  console.error("serve-all failed:", e.message);
  await shutdown(1);
}
