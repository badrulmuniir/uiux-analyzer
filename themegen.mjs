import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";

export const defaultConfig = {
  name: "Modern Base",
  slug: "modern-base",
  author: "Badrul Munir",
  colors: {
    base: "#ffffff",
    contrast: "#111827",
    primary: "#2563eb",
    secondary: "#64748b",
    accent: "#f1f5f9",
  },
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontSlug: "system-sans",
  fontName: "System Sans",
  contentSize: "680px",
  wideSize: "1100px",
  borderRadius: "8px",
  baseLineHeight: "1.6",
  fontScale: { small: "0.9rem", medium: "1rem", large: "1.5rem", xLarge: "2.25rem" },
};

const pv = (type, slug) => `var(--wp--preset--${type}--${slug})`;

// ---- fixed markup -------------------------------------------------------
const HEADER = `<!-- wp:site-title /-->\n`;
const FOOTER = `<!-- wp:site-title {"level":0} /-->\n`;

const part = (name, tag) => `<!-- wp:template-part {"slug":"${name}","tagName":"${tag}"} /-->`;
const wrapMain = (inner) =>
  `${part("header", "header")}
<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
<main class="wp-block-group">
${inner}
</main>
<!-- /wp:group -->
${part("footer", "footer")}
`;

const INDEX = wrapMain(`<!-- wp:query {"query":{"perPage":10,"postType":"post"}} -->
<div class="wp-block-query">
<!-- wp:post-template -->
<!-- wp:post-title {"isLink":true} /-->
<!-- wp:post-excerpt /-->
<!-- /wp:post-template -->
</div>
<!-- /wp:query -->`);

// Only the query loop here: a standalone post-title/post-content outside a
// loop renders the first post on a latest-posts homepage, duplicating the list.
const FRONT_PAGE = wrapMain(`<!-- wp:query {"query":{"perPage":5,"postType":"post"}} -->
<div class="wp-block-query">
<!-- wp:post-template -->
<!-- wp:post-title {"isLink":true,"level":2} /-->
<!-- wp:post-excerpt /-->
<!-- /wp:post-template -->
</div>
<!-- /wp:query -->`);

const SINGLE = wrapMain(`<!-- wp:post-title {"level":1} /-->
<!-- wp:post-date /-->
<!-- wp:post-content {"layout":{"type":"constrained"}} /-->`);

const PAGE = wrapMain(`<!-- wp:post-title {"level":1} /-->
<!-- wp:post-content {"layout":{"type":"constrained"}} /-->`);

// ---- generators ---------------------------------------------------------
function styleCss(c) {
  return `/*
Theme Name: ${c.name}
Author: ${c.author}
Version: 1.0
Requires at least: 6.0
Requires PHP: 7.4
License: GPL-2.0-or-later
Text Domain: ${c.slug}
*/
`;
}

function themeJson(c) {
  const f = c.fontScale;
  const names = { base: "Base", contrast: "Contrast", primary: "Primary", secondary: "Secondary", accent: "Accent" };
  const palette = Object.entries(c.colors).map(([slug, color]) => ({
    slug,
    color,
    name: names[slug] ?? slug[0].toUpperCase() + slug.slice(1),
  }));
  const heading = (size, top, bottom) => ({
    typography: { fontSize: pv("font-size", size), lineHeight: "1.2" },
    spacing: { margin: { top, bottom } },
  });
  return {
    $schema: "https://schemas.wp.org/trunk/theme.json",
    version: 3,
    settings: {
      layout: { contentSize: c.contentSize, wideSize: c.wideSize },
      color: { custom: false, defaultPalette: false, palette },
      typography: {
        fluid: true,
        fontFamilies: [{ slug: c.fontSlug, name: c.fontName, fontFamily: c.fontFamily }],
        fontSizes: [
          { slug: "small", name: "Small", size: f.small, fluid: false },
          { slug: "medium", name: "Medium", size: f.medium, fluid: false },
          { slug: "large", name: "Large", size: f.large, fluid: true },
          { slug: "x-large", name: "Extra Large", size: f.xLarge, fluid: true },
        ],
      },
      spacing: {
        units: ["rem", "px"],
        spacingScale: { operator: "*", increment: 1.5, steps: 7, mediumStep: 1.5, unit: "rem" },
      },
    },
    styles: {
      color: { background: pv("color", "base"), text: pv("color", "contrast") },
      typography: {
        fontFamily: pv("font-family", c.fontSlug),
        fontSize: pv("font-size", "medium"),
        lineHeight: c.baseLineHeight,
      },
      elements: {
        link: {
          color: { text: pv("color", "primary") },
          typography: { textDecoration: "none" },
          ":hover": { typography: { textDecoration: "underline" } },
        },
        button: {
          color: { background: pv("color", "primary"), text: pv("color", "base") },
          spacing: { padding: { top: "0.75rem", bottom: "0.75rem", left: "1.5rem", right: "1.5rem" } },
          border: { radius: c.borderRadius },
        },
        h1: heading("x-large", "2rem", "1rem"),
        h2: heading("large", "1.75rem", "0.875rem"),
        h3: heading("medium", "1.5rem", "0.75rem"),
        h4: heading("small", "1.25rem", "0.625rem"),
      },
      blocks: { "core/paragraph": { typography: { lineHeight: c.baseLineHeight } } },
    },
  };
}

export function generateTheme(config, outDir) {
  const c = { ...defaultConfig, ...config };
  c.colors = { ...defaultConfig.colors, ...config?.colors };
  c.fontScale = { ...defaultConfig.fontScale, ...config?.fontScale };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) {
    throw new Error(`slug must be kebab-case: "${c.slug}"`);
  }
  const root = path.join(outDir, c.slug);
  const files = {
    "style.css": styleCss(c),
    "theme.json": JSON.stringify(themeJson(c), null, 2) + "\n",
    "templates/index.html": INDEX,
    "templates/front-page.html": FRONT_PAGE,
    "templates/single.html": SINGLE,
    "templates/page.html": PAGE,
    "parts/header.html": HEADER,
    "parts/footer.html": FOOTER,
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { dir: root, files: Object.keys(files) };
}

export function zipTheme(slug, outDir) {
  const src = path.join(outDir, slug);
  const zipPath = path.join(outDir, `${slug}.zip`);
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve(zipPath));
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(src, slug); // exactly one top-level dir named <slug>
    archive.finalize();
  });
}

// ---- CLI ----------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: node themegen.mjs <slug>");
    process.exit(1);
  }
  const outDir = path.resolve("generated");
  const name = slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const { dir, files } = generateTheme({ ...defaultConfig, slug, name }, outDir);
  const zip = await zipTheme(slug, outDir);
  console.log("Theme dir:", dir);
  console.log("Zip:      ", zip);
  console.log("Files:");
  files.forEach((f) => console.log("  " + slug + "/" + f));
}
