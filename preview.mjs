import { chromium } from "playwright";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const TIMEOUT = 15000;

export async function screenshot(dir, entry, outPath) {
  const file = path.resolve(dir, entry);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", (route) =>
      route.request().url().startsWith("file://") ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    await page.goto(pathToFileURL(file).href, { timeout: TIMEOUT, waitUntil: "load" });
    await page.screenshot({ path: outPath, fullPage: true, timeout: TIMEOUT });
  } finally {
    await browser.close();
  }
  return outPath;
}

function pngSize(p) {
  const b = fs.readFileSync(p);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function report(label, p) {
  const { width, height } = pngSize(p);
  console.log(`${label}: ${path.resolve(p)} (${width}x${height}px)`);
}

async function main() {
  const folder = process.argv[2] || "sample/";
  const entry = process.argv[3] || "index.html";
  const outDir = "previews";
  fs.mkdirSync(outDir, { recursive: true });

  const before = path.join(outDir, "before.png");
  if (!fs.existsSync(path.resolve(folder, entry))) {
    console.error(`Original not found: ${path.resolve(folder, entry)}`);
    process.exit(1);
  }
  await screenshot(folder, entry, before);
  report("before", before);

  const after = path.join(outDir, "after.png");
  if (!fs.existsSync(path.resolve("candidate", entry))) {
    console.log(`after: skipped - candidate/${entry} does not exist`);
    return;
  }
  await screenshot("candidate", entry, after);
  report("after", after);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("preview failed:", e.message);
    process.exit(1);
  });
}
