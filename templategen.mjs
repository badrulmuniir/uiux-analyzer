// Adaptive theme generation (Agent 5 v2): rebuild the sections detected by structure.mjs as
// WordPress block markup in the Modern style, in the same order.
// Colours, fonts, spacing and radii come from themegen.mjs / colors.mjs (palette slugs only; no new tokens).
// CLI: node templategen.mjs <htmlPath> <themeDir>      e.g. node templategen.mjs candidate/demo-site.html generated/adaptive-demo
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectStructure, summarize } from "./structure.mjs";
import { STYLES, defaultConfig, generateTheme, zipTheme } from "./themegen.mjs";

const TOKENS = { ...defaultConfig, ...STYLES.modern }; // radii etc. from the Modern style

// ---- escaping ---------------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// JSON inside a block comment must not contain "--", "<", ">" or "&" (same escaping WordPress uses)
const wpJson = (o) =>
  JSON.stringify(o).replace(/--/g, "\\u002d\\u002d").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const cssVal = (v) => String(v).replace(/^var:preset\|([^|]+)\|(.+)$/, "var(--wp--preset--$1--$2)");
const SP = (n) => `var:preset|spacing|${n}`;

// ---- block builders (saved markup matches what WordPress would serialise) ----------------------------
const block = (name, attrs, html) => {
  const a = attrs && Object.keys(attrs).length ? " " + wpJson(attrs) : "";
  return html === undefined ? `<!-- wp:${name}${a} /-->` : `<!-- wp:${name}${a} -->\n${html}\n<!-- /wp:${name} -->`;
};

function heading(text, level, { fontSize, align, textColor } = {}) {
  const attrs = {};
  if (align) attrs.textAlign = align;
  if (level !== 2) attrs.level = level;
  if (textColor) attrs.textColor = textColor;
  if (fontSize) attrs.fontSize = fontSize;
  const cls = ["wp-block-heading", align && `has-text-align-${align}`, textColor && `has-${textColor}-color has-text-color`, fontSize && `has-${fontSize}-font-size`].filter(Boolean).join(" ");
  return block("heading", attrs, `<h${level} class="${cls}">${esc(text)}</h${level}>`);
}

function paragraph(text, { fontSize, textColor, align, html, weight } = {}) {
  const attrs = {};
  if (align) attrs.align = align;
  if (textColor) attrs.textColor = textColor;
  if (fontSize) attrs.fontSize = fontSize;
  if (weight) attrs.style = { typography: { fontWeight: weight } };
  const cls = [align && `has-text-align-${align}`, textColor && `has-${textColor}-color has-text-color`, fontSize && `has-${fontSize}-font-size`].filter(Boolean).join(" ");
  return block("paragraph", attrs, `<p${cls ? ` class="${cls}"` : ""}${weight ? ` style="font-weight:${weight}"` : ""}>${html ?? esc(text)}</p>`);
}

function group({ tag = "div", className, anchor, align, bg, text, borderColor, borderWidth, radius, padding, margin, layout, inner }) {
  const attrs = {};
  if (tag !== "div") attrs.tagName = tag;
  if (anchor) attrs.anchor = anchor;
  if (className) attrs.className = className;
  if (align) attrs.align = align;
  if (bg) attrs.backgroundColor = bg;
  if (text) attrs.textColor = text;
  if (borderColor) attrs.borderColor = borderColor;
  const style = {};
  if (borderWidth || radius) style.border = { ...(borderWidth && { width: borderWidth }), ...(radius && { radius }) };
  if (padding || margin) style.spacing = { ...(padding && { padding }), ...(margin && { margin }) };
  if (Object.keys(style).length) attrs.style = style;
  if (layout) attrs.layout = layout;

  const css = [];
  if (radius) css.push(`border-radius:${radius}`);
  if (borderWidth) css.push(`border-width:${borderWidth}`);
  for (const [k, v] of Object.entries(margin || {})) css.push(`margin-${k}:${cssVal(v)}`);
  for (const [k, v] of Object.entries(padding || {})) css.push(`padding-${k}:${cssVal(v)}`);
  const cls = [
    "wp-block-group",
    align && `align${align}`,
    className,
    text && `has-${text}-color`,
    bg && `has-${bg}-background-color`,
    text && "has-text-color",
    bg && "has-background",
    borderColor && `has-border-color has-${borderColor}-border-color`,
  ].filter(Boolean).join(" ");
  const open = `<${tag}${anchor ? ` id="${esc(anchor)}"` : ""} class="${cls}"${css.length ? ` style="${css.join(";")}"` : ""}>`;
  return block("group", attrs, `${open}\n${inner}\n</${tag}>`);
}

const sectionPad = { top: SP(60), bottom: SP(60) };

// ---- section renderers -------------------------------------------------------------------------------
function renderHeader(s) {
  const links = s.nav
    .map((n) => block("navigation-link", { label: n.label, type: "custom", url: n.url || "#", kind: "custom", isTopLevelLink: true }))
    .join("\n");
  const title = paragraph(null, { fontSize: "medium", weight: "500", html: `<a href="/">${esc(s.siteTitle || "Home")}</a>` });
  const nav = block("navigation", { fontSize: "small", overlayMenu: "mobile", layout: { type: "flex", justifyContent: "right" } }, links);
  return group({
    className: "site-header",
    align: "wide",
    layout: { type: "flex", flexWrap: "nowrap", justifyContent: "space-between" },
    padding: { top: "1rem", bottom: "1rem", left: SP(40), right: SP(40) },
    inner: `${title}\n${nav}`,
  });
}

function renderHero(s) {
  const parts = [heading(s.heading, 1, { align: "center", fontSize: "xx-large" })];
  if (s.subheading) parts.push(paragraph(s.subheading, { align: "center", textColor: "secondary", fontSize: "large" }));
  if (s.buttons?.length) {
    const btns = s.buttons.map((b, i) => {
      const label = esc(b.label);
      const href = b.url ? ` href="${esc(b.url)}"` : "";
      const r = TOKENS.borderRadius;
      return i === 0
        ? block("button", { backgroundColor: "primary", textColor: "base", style: { border: { radius: r } }, ...(b.url && { url: b.url }) },
            `<div class="wp-block-button"><a class="wp-block-button__link has-base-color has-primary-background-color has-text-color has-background wp-element-button"${href} style="border-radius:${r}">${label}</a></div>`)
        : block("button", { className: "is-style-outline", style: { border: { radius: r } }, ...(b.url && { url: b.url }) },
            `<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button"${href} style="border-radius:${r}">${label}</a></div>`);
    });
    parts.push(block("buttons", { layout: { type: "flex", justifyContent: "center" } }, `<div class="wp-block-buttons">\n${btns.join("\n")}\n</div>`));
  }
  return group({
    tag: "section",
    align: "full",
    bg: "accent",
    padding: { top: SP(70), bottom: SP(70), left: SP(40), right: SP(40) },
    layout: { type: "constrained" },
    inner: parts.join("\n"),
  });
}

function renderCards(s, anchor) {
  const parts = [];
  if (s.heading) parts.push(heading(s.heading, 2));
  if (s.intro) parts.push(paragraph(s.intro, { textColor: "secondary" }));
  const cards = s.items.map((item) =>
    group({
      className: "adaptive-card",
      bg: "accent",
      radius: TOKENS.cardRadius,
      padding: { top: SP(30), bottom: SP(30), left: SP(30), right: SP(30) },
      layout: { type: "constrained" },
      inner: [heading(item.title, 3, { fontSize: "large" }), item.text ? paragraph(item.text, { fontSize: "small", textColor: "secondary" }) : null].filter(Boolean).join("\n"),
    })
  );
  parts.push(group({ align: "wide", layout: { type: "grid", columnCount: 3, minimumColumnWidth: "16rem" }, inner: cards.join("\n") }));
  return group({ tag: "section", anchor, align: "wide", padding: sectionPad, layout: { type: "constrained" }, inner: parts.join("\n") });
}

function renderProse(s, anchor) {
  const parts = [];
  if (s.heading) parts.push(heading(s.heading, 2));
  for (const p of s.paragraphs) parts.push(paragraph(p));
  if (!parts.length) return "";
  return group({ tag: "section", anchor, align: "wide", padding: sectionPad, layout: { type: "constrained" }, inner: parts.join("\n") });
}

const renderNote = (s) => paragraph(s.text, { fontSize: "small", textColor: "secondary" });

function renderCallout(s) {
  return group({
    className: "adaptive-callout",
    bg: "accent",
    borderColor: "primary",
    borderWidth: "1px",
    radius: TOKENS.cardRadius,
    padding: { top: SP(30), bottom: SP(30), left: SP(40), right: SP(40) },
    layout: { type: "constrained" },
    inner: paragraph(s.text),
  });
}

// Field names: keep the detected name attribute; when it is missing, derive one from the label/type.
function fieldNames(fields) {
  const used = new Set();
  return fields.map((f) => {
    let name = f.name;
    if (!name) {
      if (f.type === "email") name = "email";
      else if (f.type === "tel") name = "phone";
      else {
        name = (f.label || f.type)
          .toLowerCase()
          .replace(/^(your|select an?|choose an?|enter your|enter)\s+/, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || f.type;
      }
    }
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
    used.add(unique);
    return { ...f, name: unique, generatedName: !f.name };
  });
}

function renderForm(s, anchor) {
  const r = TOKENS.borderRadius;
  const control =
    `display:block;width:100%;box-sizing:border-box;padding:0.75rem;font:inherit;` +
    `color:var(--wp--preset--color--contrast);background:var(--wp--preset--color--base);` +
    `border:1px solid var(--wp--preset--color--secondary);border-radius:${r}`;
  const fields = fieldNames(s.fields);
  const rows = fields.map((f, i) => {
    const id = `field-${f.name.replace(/_/g, "-")}`;
    const label = `<label for="${id}" style="display:block;margin-bottom:0.375rem;font-weight:500">${esc(f.label || f.name)}</label>`;
    let input;
    if (f.type === "textarea") {
      input = `<textarea id="${id}" name="${esc(f.name)}" rows="4" style="${control}"></textarea>`;
    } else if (f.type === "select") {
      const placeholder = f.labelSource === "first-option" ? `<option value="">${esc(f.label)}</option>` : `<option value="">Choose...</option>`;
      const opts = (f.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
      input = `<select id="${id}" name="${esc(f.name)}" style="${control}">${placeholder}${opts}</select>`;
    } else {
      input = `<input id="${id}" name="${esc(f.name)}" type="${esc(f.type)}" style="${control}">`;
    }
    return `<div style="margin-bottom:1.25rem">${label}${input}</div>`;
  });
  const submit = esc(s.submitLabel || "Send");
  const form = `<form class="adaptive-form" action="#" method="post">\n${rows.join("\n")}\n<button type="submit" class="wp-element-button">${submit}</button>\n</form>`;
  const parts = [];
  if (s.heading) parts.push(heading(s.heading, 2));
  if (s.intro) parts.push(paragraph(s.intro, { textColor: "secondary" }));
  parts.push(block("html", {}, form));
  return {
    markup: group({ tag: "section", anchor, align: "wide", padding: sectionPad, layout: { type: "constrained" }, inner: parts.join("\n") }),
    generatedNames: fields.filter((f) => f.generatedName).map((f) => `${f.label || f.type} -> ${f.name}`),
  };
}

// ---- front-page ----------------------------------------------------------------------------------------
export function generateFrontPage(sections) {
  const notes = { generatedNames: [], skipped: [] };

  // "#contact" style nav links point at a section: give the matching section that id
  const anchors = (sections.find((s) => s.kind === "header")?.nav ?? [])
    .map((n) => (n.url || "").match(/^#([\w-]+)$/)?.[1])
    .filter(Boolean);
  const anchorFor = (s) => {
    const text = `${s.heading ?? ""} ${s.kind}`.toLowerCase();
    return anchors.find((a) => text.includes(a.toLowerCase()));
  };

  const body = [];
  let header = "";
  for (const s of sections) {
    switch (s.kind) {
      case "header": header = renderHeader(s); break;
      case "hero": body.push(renderHero(s)); break;
      case "cards": body.push(renderCards(s, anchorFor(s))); break;
      case "prose": { const m = renderProse(s, anchorFor(s)); if (m) body.push(m); break; }
      case "note": body.push(renderNote(s)); break;
      case "callout": body.push(renderCallout(s)); break;
      case "form": {
        const f = renderForm(s, anchorFor(s));
        notes.generatedNames.push(...f.generatedNames);
        body.push(f.markup);
        break;
      }
      case "footer": break; // always the theme's own footer part, below
      default: notes.skipped.push(s.kind);
    }
  }
  const main = group({ tag: "main", layout: { type: "constrained" }, inner: body.join("\n") });
  const footer = block("template-part", { slug: "footer", tagName: "div" });
  return { markup: [header, main, footer].filter(Boolean).join("\n") + "\n", notes };
}

// ---- whole theme -----------------------------------------------------------------------------------------
export async function generateAdaptiveTheme(htmlPath, themeDir, { style = "modern" } = {}) {
  const slug = path.basename(path.resolve(themeDir));
  const outDir = path.dirname(path.resolve(themeDir));
  const sections = await detectStructure(htmlPath);

  // brand colour from the source page's own CSS (same approach as the fixed-template flow)
  const dir = path.dirname(path.resolve(htmlPath));
  const css = [htmlPath, ...fs.readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => path.join(dir, f))]
    .map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const name = slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

  // everything except the front page (theme.json, style.css, parts, other templates, fonts) comes from themegen
  const base = generateTheme(style, { slug, name, colorMode: "brand", brandCss: css }, outDir);
  const { markup, notes } = generateFrontPage(sections);
  fs.writeFileSync(path.join(base.dir, "templates", "front-page.html"), markup);
  const zip = await zipTheme(slug, outDir);
  return { ...base, zip, sections, notes, frontPage: path.join(base.dir, "templates", "front-page.html") };
}

// ---- CLI ---------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [htmlPath, themeDir] = process.argv.slice(2);
  if (!htmlPath || !themeDir) {
    console.error("Usage: node templategen.mjs <htmlPath> <themeDir>   (e.g. candidate/demo-site.html generated/adaptive-demo)");
    process.exit(1);
  }
  try {
    const r = await generateAdaptiveTheme(htmlPath, themeDir);
    console.log(`Detected: ${summarize(r.sections)}`);
    console.log(`Theme dir:  ${r.dir}`);
    console.log(`Front page: ${r.frontPage} (${fs.statSync(r.frontPage).size} bytes)`);
    console.log(`Zip:        ${r.zip}`);
    if (r.notes.generatedNames.length) console.log(`Form field names generated (the source had none): ${r.notes.generatedNames.join("; ")}`);
    if (r.notes.skipped.length) console.log(`Skipped section kinds: ${r.notes.skipped.join(", ")}`);
  } catch (e) {
    console.error("templategen failed:", e.message);
    process.exit(1);
  }
}
