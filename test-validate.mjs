// Breaks a copy of generated/modern-base in five ways and checks that
// validateStatic fails exactly the right check(s) for each. Run: node test-validate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { validateStatic } from "./validate-theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "generated", "modern-base");
if (!fs.existsSync(source)) {
  console.error("generated/modern-base not found - run: node themegen.mjs modern modern-base");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));

// Each variant: copy the theme under a new slug, apply a break, zip it.
const variants = [
  {
    name: "control (unbroken)",
    expectFail: [],
  },
  {
    name: "style.css Theme Name removed",
    expectFail: [2],
    break: (dir) => {
      const f = path.join(dir, "style.css");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^Theme Name:.*\r?\n/m, ""));
    },
  },
  {
    name: "templates/index.html deleted",
    expectFail: [3],
    break: (dir) => fs.rmSync(path.join(dir, "templates", "index.html")),
  },
  {
    name: "theme.json invalid JSON",
    expectFail: [4, 6], // 6 fails too: no palette can be read
    break: (dir) => fs.writeFileSync(path.join(dir, "theme.json"), '{ "version": 3, "settings": { '),
  },
  {
    name: "primary set to #cccccc",
    expectFail: [6],
    break: (dir) => {
      const f = path.join(dir, "theme.json");
      const t = JSON.parse(fs.readFileSync(f, "utf8"));
      t.settings.color.palette.find((c) => c.slug === "primary").color = "#cccccc";
      fs.writeFileSync(f, JSON.stringify(t, null, 2));
    },
  },
  {
    name: "zip with files at archive root",
    expectFail: [1],
    rootZip: true,
  },
];

function build(v, i) {
  const slug = `variant-${i}`;
  const dir = path.join(tmp, slug);
  fs.cpSync(source, dir, { recursive: true });
  v.break?.(dir);
  const zip = new AdmZip();
  if (v.rootZip) zip.addLocalFolder(dir); // no top-level directory
  else zip.addLocalFolder(dir, slug);
  zip.writeZip(dir + ".zip");
  return dir;
}

let failures = 0;
try {
  for (const [i, v] of variants.entries()) {
    const result = await validateStatic(build(v, i));
    const failed = result.checks.filter((c) => !c.passed).map((c) => c.id);
    const good = JSON.stringify(failed) === JSON.stringify(v.expectFail);
    if (!good) failures++;
    console.log(`${good ? "OK  " : "BAD "} ${v.name}`);
    console.log(`       expected FAIL: [${v.expectFail.join(", ") || "none"}]   got FAIL: [${failed.join(", ") || "none"}]`);
    for (const c of result.checks.filter((c) => !c.passed)) console.log(`       check ${c.id} ${c.name}: ${c.detail}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ntemp folder removed: ${!fs.existsSync(tmp)} (${tmp})`);
}
console.log(failures ? `${failures} variant(s) not caught as expected` : "All breaks were caught by the right checks.");
process.exit(failures ? 1 : 0);
