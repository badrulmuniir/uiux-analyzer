import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";
import { derivePalette, extractBrandColors } from "./colors.mjs";

// Values shared by every style. A style only lists what differs.
export const defaultConfig = {
  name: "Theme",
  slug: "theme",
  author: "Badrul Munir",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSlug: "inter",
  fontName: "Inter",
  headingFont: null, // optional { slug, name, fontFamily } used for h1-h4
  // Bundled font files live in themes/_assets/fonts and are copied to <slug>/assets/fonts.
  // Inter from Google Fonts is one variable woff2 (latin) covering weights 100-900,
  // so a single face with a weight range serves 400, 500, 600 and so on.
  fontFiles: ["Inter-latin-variable.woff2"],
  fontFaces: [{ fontWeight: "100 900", file: "Inter-latin-variable.woff2" }],
  contentSize: "720px",
  wideSize: "1200px",
  blockGap: "1.5rem",
  baseLineHeight: "1.7",
  linkUnderline: false, // true = links always underlined
  cardStyle: "lift", // "lift" = soft border + hover shadow/lift, "flat" = hairline only
  fontScale: {
    small: { min: "0.875rem", max: "0.9375rem" },
    medium: { min: "1rem", max: "1.0625rem" },
    large: { min: "1.25rem", max: "1.5rem" },
    xLarge: { min: "1.75rem", max: "2.25rem" },
    xxLarge: { min: "2.25rem", max: "3.5rem" },
  },
};

// Token values that differ per style.
//   borderRadius: buttons. cardRadius: cards and the CTA box.
//   cardBg / footer.*: palette slugs. The footer is always lighter than the
//   page on dark styles (bold) and darker on light styles.
export const STYLES = {
  modern: {
    colors: { base: "#ffffff", contrast: "#0f172a", primary: "#2563eb", secondary: "#475569", accent: "#f8fafc" },
    borderRadius: "8px",
    cardRadius: "12px",
    headingWeight: "500",
    letterSpacing: "-0.02em",
    cardBg: "base",
    footer: { bg: "contrast", text: "base", link: "accent", hover: "base" },
  },
  minimal: {
    colors: { base: "#ffffff", contrast: "#171717", primary: "#171717", secondary: "#737373", accent: "#fafafa" },
    headingFont: { slug: "serif", name: "Serif", fontFamily: "Georgia, 'Times New Roman', Times, serif" },
    borderRadius: "0px",
    cardRadius: "0px",
    headingWeight: "400",
    letterSpacing: "-0.01em",
    cardStyle: "flat",
    linkUnderline: true, // primary equals body text colour, so underline marks links
    cardBg: "base",
    footer: { bg: "contrast", text: "base", link: "accent", hover: "base" },
  },
  bold: {
    colors: { base: "#0f172a", contrast: "#ffffff", primary: "#a78bfa", secondary: "#94a3b8", accent: "#1e293b" },
    borderRadius: "16px",
    cardRadius: "16px",
    headingWeight: "600",
    letterSpacing: "-0.03em",
    cardBg: "accent",
    // Page is dark (base), so the footer uses accent, which is lighter than base.
    footer: { bg: "accent", text: "contrast", link: "contrast", hover: "primary" },
    fontScale: {
      large: { min: "1.375rem", max: "1.75rem" },
      xLarge: { min: "2rem", max: "3rem" },
      xxLarge: { min: "2.75rem", max: "5rem" },
    },
  },
};

const pv = (type, slug) => `var(--wp--preset--${type}--${slug})`;

// ---- fixed markup -------------------------------------------------------
// Core blocks only. The bottom border comes from .site-header in style.css.
const HEADER = `<!-- wp:group {"className":"site-header","align":"wide","style":{"spacing":{"padding":{"top":"1rem","bottom":"1rem","left":"var:preset|spacing|40","right":"var:preset|spacing|40"}}},"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between"}} -->
<div class="wp-block-group alignwide site-header" style="padding-top:1rem;padding-right:var(--wp--preset--spacing--40);padding-bottom:1rem;padding-left:var(--wp--preset--spacing--40)">
<!-- wp:site-title {"level":0,"fontSize":"medium","style":{"typography":{"fontWeight":"500","textDecoration":"none"}}} /-->
<!-- wp:navigation {"fontSize":"small","overlayMenu":"mobile","layout":{"type":"flex","justifyContent":"right"}} /-->
</div>
<!-- /wp:group -->
`;
// The group is the <footer> element, so the template-part wrapper is a div
// (see wrapMain) to avoid a footer nested in a footer. Link colours on the
// dark background are set in style.css (.site-footer a).
const FOOTER = `<!-- wp:group {"tagName":"footer","align":"full","className":"site-footer","backgroundColor":"%FOOT_BG%","textColor":"%FOOT_TX%","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|40","right":"var:preset|spacing|40"}}},"layout":{"type":"constrained"}} -->
<footer class="wp-block-group alignfull site-footer has-%FOOT_TX%-color has-%FOOT_BG%-background-color has-text-color has-background" style="padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--40)">
<!-- wp:group {"align":"wide","layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"center"}} -->
<div class="wp-block-group alignwide">
<!-- wp:group {"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group">
<!-- wp:site-title {"level":0,"fontSize":"medium","style":{"typography":{"fontWeight":"500"}}} /-->
<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size">&copy; ${new Date().getFullYear()} All rights reserved.</p>
<!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><a href="/">Home</a> &middot; <a href="/feed/">RSS</a></p>
<!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
</footer>
<!-- /wp:group -->
`;

const CTA = `<!-- wp:group {"backgroundColor":"accent","style":{"border":{"radius":"%CARD_R%"},"spacing":{"margin":{"left":"var:preset|spacing|40","right":"var:preset|spacing|40","bottom":"var:preset|spacing|60"},"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|50","right":"var:preset|spacing|50"}}},"layout":{"type":"constrained","contentSize":"480px"}} -->
<div class="wp-block-group has-accent-background-color has-background" style="border-radius:%CARD_R%;margin-right:var(--wp--preset--spacing--40);margin-bottom:var(--wp--preset--spacing--60);margin-left:var(--wp--preset--spacing--40);padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--50)">
<!-- wp:heading {"textAlign":"center","fontSize":"large"} -->
<h2 class="wp-block-heading has-text-align-center has-large-font-size">Want the newsletter?</h2>
<!-- /wp:heading -->
<!-- wp:paragraph {"align":"center","textColor":"secondary","fontSize":"small"} -->
<p class="has-text-align-center has-secondary-color has-text-color has-small-font-size">One short note a month. No noise.</p>
<!-- /wp:paragraph -->
<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"primary","textColor":"base","style":{"border":{"radius":"%BTN_R%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-base-color has-primary-background-color has-text-color has-background wp-element-button" style="border-radius:%BTN_R%">Subscribe</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->
</div>
<!-- /wp:group -->`;

const HERO = `<!-- wp:group {"tagName":"section","backgroundColor":"accent","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70","left":"var:preset|spacing|40","right":"var:preset|spacing|40"}}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group has-accent-background-color has-background" style="padding-top:var(--wp--preset--spacing--70);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--70);padding-left:var(--wp--preset--spacing--40)">
<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"xx-large"} -->
<h1 class="wp-block-heading has-text-align-center has-xx-large-font-size">Build something worth keeping</h1>
<!-- /wp:heading -->
<!-- wp:paragraph {"align":"center","textColor":"secondary","fontSize":"large"} -->
<p class="has-text-align-center has-secondary-color has-text-color has-large-font-size">Simple tools, thoughtful design, and room to grow.</p>
<!-- /wp:paragraph -->
<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"primary","textColor":"base","style":{"border":{"radius":"%BTN_R%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-base-color has-primary-background-color has-text-color has-background wp-element-button" style="border-radius:%BTN_R%">Get started</a></div>
<!-- /wp:button -->
<!-- wp:button {"className":"is-style-outline","style":{"border":{"radius":"%BTN_R%"}}} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" style="border-radius:%BTN_R%">Read more</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->
</section>
<!-- /wp:group -->`;

const part = (name, tag) => `<!-- wp:template-part {"slug":"${name}","tagName":"${tag}"} /-->`;
const wrapMain = (inner, beforeMain = "") =>
  `${part("header", "header")}
${beforeMain ? beforeMain + "\n" : ""}<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
<main class="wp-block-group">
${inner}
</main>
<!-- /wp:group -->
${part("footer", "div")}
`;

// Card grid shared by index and front-page. The grid layout lives on
// post-template (that is where core reads it); the card border colour, hover
// and transition are in style.css via .post-card.
const POST_GRID = `<!-- wp:group {"tagName":"section","align":"wide","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"}}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignwide" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)">
<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Latest writing</h2>
<!-- /wp:heading -->
<!-- wp:paragraph {"textColor":"secondary","fontSize":"small"} -->
<p class="has-secondary-color has-text-color has-small-font-size">Notes from the studio</p>
<!-- /wp:paragraph -->
<!-- wp:query {"query":{"perPage":6,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","inherit":false},"align":"wide"} -->
<div class="wp-block-query alignwide">
<!-- wp:post-template {"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"16rem"}} -->
<!-- wp:group {"className":"post-card","backgroundColor":"%CARD_BG%","style":{"border":{"width":"1px","radius":"%CARD_R%"},"spacing":{"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|30","left":"var:preset|spacing|30","right":"var:preset|spacing|30"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group post-card has-%CARD_BG%-background-color has-background" style="border-width:1px;border-radius:%CARD_R%;padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--30);padding-left:var(--wp--preset--spacing--30)">
<!-- wp:post-featured-image {"isLink":true,"aspectRatio":"16/9","style":{"border":{"radius":"%IMG_R%"}}} /-->
<!-- wp:post-terms {"term":"category","fontSize":"small","textColor":"primary"} /-->
<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"large","style":{"typography":{"textDecoration":"none"}}} /-->
<!-- wp:post-excerpt {"moreText":"","excerptLength":18,"textColor":"secondary","fontSize":"small"} /-->
</div>
<!-- /wp:group -->
<!-- /wp:post-template -->
</div>
<!-- /wp:query -->
</section>
<!-- /wp:group -->`;

const INDEX = wrapMain(POST_GRID);

// Hero, then only the post grid: a standalone post-title/post-content outside
// a loop renders the first post on a latest-posts homepage, duplicating the list.
const FRONT_PAGE = wrapMain(`${POST_GRID}\n${CTA}`, HERO);

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

.site-header {
  border-bottom: 1px solid color-mix(in srgb, var(--wp--preset--color--contrast) 12%, transparent);
}

/* Footer links use a palette colour chosen per style to stay readable on the footer background. */
.site-footer a {
  color: var(--wp--preset--color--${c.footer.link});
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.site-footer a:hover,
.site-footer a:focus {
  color: var(--wp--preset--color--${c.footer.hover});
}

${cardCss(c)}`;
}

function cardCss(c) {
  if (c.cardStyle === "flat") {
    return `/* Hairline cards: no shadow, no hover lift. */
.post-card {
  border-style: solid;
  border-color: color-mix(in srgb, var(--wp--preset--color--contrast) 20%, transparent);
  box-shadow: none;
}
`;
  }
  return `.post-card {
  border-style: solid;
  border-color: color-mix(in srgb, var(--wp--preset--color--contrast) 10%, transparent);
  transition: transform 150ms ease, box-shadow 150ms ease;
}

.post-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--wp--preset--color--contrast) 8%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .post-card { transition: none; }
  .post-card:hover { transform: none; }
}
`;
}

// Fill the %TOKEN% placeholders in the fixed template/part markup.
function fillMarkup(markup, c) {
  const imgR = `${Math.max(0, parseInt(c.cardRadius, 10) - 4)}px`;
  const map = {
    "%BTN_R%": c.borderRadius,
    "%CARD_R%": c.cardRadius,
    "%IMG_R%": imgR,
    "%CARD_BG%": c.cardBg,
    "%FOOT_BG%": c.footer.bg,
    "%FOOT_TX%": c.footer.text,
  };
  let out = markup;
  for (const [token, value] of Object.entries(map)) out = out.split(token).join(value);
  return out;
}

// [slug, display name, fontScale key]
const FONT_SIZES = [
  ["small", "Small", "small"],
  ["medium", "Medium", "medium"],
  ["large", "Large", "large"],
  ["x-large", "Extra Large", "xLarge"],
  ["xx-large", "Extra Extra Large", "xxLarge"],
];

// [slug, size] - 1rem up to 6rem for generous section padding
const SPACING_SIZES = [
  ["20", "1rem"],
  ["30", "1.5rem"],
  ["40", "2rem"],
  ["50", "3rem"],
  ["60", "4rem"],
  ["70", "5rem"],
  ["80", "6rem"],
];

function themeJson(c) {
  const f = c.fontScale;
  const names = { base: "Base", contrast: "Contrast", primary: "Primary", secondary: "Secondary", accent: "Accent" };
  const palette = Object.entries(c.colors).map(([slug, color]) => ({
    slug,
    color,
    name: names[slug] ?? slug[0].toUpperCase() + slug.slice(1),
  }));
  const headingFamily = c.headingFont ? pv("font-family", c.headingFont.slug) : undefined;
  const heading = (size, top, bottom, lineHeight, letterSpacing) => ({
    typography: {
      ...(headingFamily && { fontFamily: headingFamily }),
      fontSize: pv("font-size", size),
      lineHeight,
      ...(letterSpacing && { letterSpacing }),
      fontWeight: c.headingWeight,
    },
    spacing: { margin: { top, bottom } },
  });
  const halfSpacing = `${parseFloat(c.letterSpacing) / 2}em`;
  const fontFamilies = [
    {
      slug: c.fontSlug,
      name: c.fontName,
      fontFamily: c.fontFamily,
      fontFace: c.fontFaces.map((ff) => ({
        fontFamily: c.fontName,
        fontWeight: ff.fontWeight,
        fontStyle: "normal",
        fontDisplay: "swap",
        src: [`file:./assets/fonts/${ff.file}`],
      })),
    },
    ...(c.headingFont ? [c.headingFont] : []),
  ];
  return {
    $schema: "https://schemas.wp.org/trunk/theme.json",
    version: 3,
    settings: {
      layout: { contentSize: c.contentSize, wideSize: c.wideSize },
      color: { custom: false, defaultPalette: false, palette },
      typography: {
        fluid: true,
        fontFamilies,
        fontSizes: FONT_SIZES.map(([slug, name, key]) => ({
          slug,
          name,
          size: f[key].max,
          fluid: { min: f[key].min, max: f[key].max },
        })),
      },
      spacing: {
        units: ["rem", "px"],
        spacingSizes: SPACING_SIZES.map(([slug, size]) => ({ slug, name: slug, size })),
      },
    },
    styles: {
      color: { background: pv("color", "base"), text: pv("color", "contrast") },
      typography: {
        fontFamily: pv("font-family", c.fontSlug),
        fontSize: pv("font-size", "medium"),
        lineHeight: c.baseLineHeight,
      },
      spacing: { blockGap: c.blockGap },
      elements: {
        link: {
          color: { text: pv("color", "primary") },
          typography: { textDecoration: c.linkUnderline ? "underline" : "none" },
          ":hover": { typography: { textDecoration: "underline" } },
        },
        button: {
          color: { background: pv("color", "primary"), text: pv("color", "base") },
          spacing: { padding: { top: "0.75rem", bottom: "0.75rem", left: "1.5rem", right: "1.5rem" } },
          border: { radius: c.borderRadius },
        },
        h1: heading("xx-large", "2rem", "1rem", "1.1", c.letterSpacing),
        h2: heading("x-large", "1.75rem", "0.875rem", "1.2", halfSpacing),
        h3: heading("large", "1.5rem", "0.75rem", "1.3"),
        h4: heading("medium", "1.25rem", "0.625rem", "1.3"),
      },
      blocks: { "core/paragraph": { typography: { lineHeight: c.baseLineHeight } } },
    },
  };
}

export function generateTheme(styleName, overrides, outDir) {
  const style = STYLES[styleName];
  if (!style) throw new Error(`unknown style "${styleName}" (have: ${Object.keys(STYLES).join(", ")})`);
  // options: { colorMode: "preset"|"brand"|"custom", customColor, brandCss, ...config overrides }
  const { colorMode = "preset", customColor, brandCss, ...rest } = overrides ?? {};
  // defaults < style < overrides; nested token groups merge one level deep
  const c = { ...defaultConfig, ...style, ...rest };
  for (const k of ["colors", "fontScale", "footer"]) {
    c[k] = { ...defaultConfig[k], ...style[k], ...rest[k] };
  }

  let sourceColor = null;
  if (colorMode === "custom") {
    if (!customColor) throw new Error('colorMode "custom" needs options.customColor');
    sourceColor = customColor;
  } else if (colorMode === "brand") {
    sourceColor = extractBrandColors(brandCss);
    if (!sourceColor) console.log("No brand colour found in the CSS, using the preset palette.");
    else console.log(`Brand colour detected: ${sourceColor}`);
  } else if (colorMode !== "preset") {
    throw new Error(`unknown colorMode "${colorMode}" (preset, brand, custom)`);
  }
  const adjustments = [];
  if (sourceColor) {
    // explicit overrides.colors still win over the derived palette
    c.colors = { ...derivePalette(sourceColor, styleName, adjustments), ...rest.colors };
    for (const a of adjustments) {
      console.log(`${a.dark ? "Lightened" : "Darkened"} ${a.from} to ${a.to} so text passes 4.5:1`);
    }
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) {
    throw new Error(`slug must be kebab-case: "${c.slug}"`);
  }
  const root = path.join(outDir, c.slug);
  const files = {
    "style.css": styleCss(c),
    "theme.json": JSON.stringify(themeJson(c), null, 2) + "\n",
    "templates/index.html": fillMarkup(INDEX, c),
    "templates/front-page.html": fillMarkup(FRONT_PAGE, c),
    "templates/single.html": fillMarkup(SINGLE, c),
    "templates/page.html": fillMarkup(PAGE, c),
    "parts/header.html": fillMarkup(HEADER, c),
    "parts/footer.html": fillMarkup(FOOTER, c),
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const fontSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), "themes", "_assets", "fonts");
  const fontOut = path.join(root, "assets", "fonts");
  fs.mkdirSync(fontOut, { recursive: true });
  const written = Object.keys(files);
  for (const f of c.fontFiles) {
    fs.copyFileSync(path.join(fontSrc, f), path.join(fontOut, f));
    written.push(`assets/fonts/${f}`);
  }
  return { dir: root, files: written, colors: c.colors, adjustments };
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
  const usage = `Usage: node themegen.mjs <${Object.keys(STYLES).join("|")}> <slug> [--color=#hex] [--brand=file.css] [--mode=preset|custom|brand]`;
  console.log("raw argv:", process.argv);

  // positionals: <style> <slug>; flags: --key=value (the value may start with #)
  const positional = [];
  const flags = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (m) flags[m[1]] = m[2];
    else if (arg.startsWith("--")) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  const [styleName, slug] = positional;
  const options = { slug };
  if (flags.color !== undefined) {
    options.colorMode = "custom"; // --color implies custom, no --mode needed
    options.customColor = flags.color;
  } else if (flags.brand !== undefined) {
    options.colorMode = "brand";
    options.brandCss = fs.readFileSync(path.resolve(flags.brand), "utf8");
  }
  if (typeof flags.mode === "string") options.colorMode = flags.mode; // explicit --mode wins
  console.log("parsed options:", { style: styleName, ...options, brandCss: options.brandCss && `<${options.brandCss.length} chars>` });

  if (!STYLES[styleName] || !slug) {
    console.error(usage);
    process.exit(1);
  }
  const outDir = path.resolve("generated");
  options.name = slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const { dir, files, colors } = generateTheme(styleName, options, outDir);
  const zip = await zipTheme(slug, outDir);
  console.log("Theme dir:", dir);
  console.log("Zip:      ", zip);
  console.log("Final palette:", colors);
  console.log("Files:");
  files.forEach((f) => console.log("  " + slug + "/" + f));
}
