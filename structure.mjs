// Structure detection for Agent 5 v2: find the sections of a (fixed) HTML page, in document order.
// Detection only - nothing here generates a theme.
// CLI: node structure.mjs <htmlPath>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

// Runs inside the page, so a real DOM and real computed styles do the parsing.
function detectInPage() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const body = document.body;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "PICTURE", "IMG"]);
  const BLOCK = /^(DIV|SECTION|ARTICLE|MAIN|ASIDE|UL|OL|LI|BLOCKQUOTE|DL|DD|DT|TABLE|THEAD|TBODY|TR|TD|TH|P|H[1-6]|PRE|FIGURE|DETAILS|SUMMARY|FORM|FIELDSET)$/;
  const ITEM_TAGS = new Set(["DIV", "LI", "ARTICLE", "SECTION"]);

  const hidden = (el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  };
  const isControl = (el) => {
    const t = el.tagName;
    if (t === "TEXTAREA" || t === "SELECT") return true;
    if (t !== "INPUT") return false;
    return !["hidden", "submit", "button", "reset", "image"].includes((el.type || "text").toLowerCase());
  };
  // visible text, ignoring scripts, svg, form controls and buttons inside
  const textOf = (el) => {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent + " ";
      else if (n.nodeType === 1 && !SKIP.has(n.tagName) && !isControl(n) && n.tagName !== "BUTTON" && !hidden(n)) out += textOf(n) + " ";
    }
    return clean(out);
  };
  const accName = (el) => clean(el.getAttribute("aria-label")) || clean(el.textContent) || clean(el.getAttribute("title")) || clean(el.value);
  const topLevel = (el) => {
    while (el.parentElement && el.parentElement !== body) el = el.parentElement;
    return el;
  };
  const links = (root) =>
    [...root.querySelectorAll("a[href]")]
      .map((a) => ({ label: clean(a.textContent) || clean(a.getAttribute("aria-label")), url: a.getAttribute("href") }))
      .filter((l) => l.label);

  // ---- header and footer ---------------------------------------------------------------------
  let headerEl = [...document.querySelectorAll("header")].find((h) => !h.closest("article, section, main, aside"));
  if (!headerEl) {
    const nav = document.querySelector("nav");
    if (nav) {
      const top = topLevel(nav);
      // a wrapper that holds headings is page content, not the header
      headerEl = top !== nav && !top.querySelector("h1, h2, h3") && textOf(top).length < 400 ? top : nav;
    }
  }
  let footerEl = [...document.querySelectorAll("footer")].filter((f) => !f.closest("article, section, main, aside")).pop();
  if (!footerEl) {
    const copy = [...body.querySelectorAll("p, small, span, div, li")]
      .filter((e) => !e.closest("header") && /(©|&copy;|copyright|all rights reserved)/i.test(e.textContent) && clean(e.textContent).length < 300)
      .filter((e) => ![...e.children].some((c) => /(©|copyright|all rights reserved)/i.test(c.textContent)))
      .pop();
    if (copy) footerEl = copy.parentElement && copy.parentElement !== body && textOf(copy.parentElement).length < 400 ? copy.parentElement : copy;
  }

  // ---- forms -----------------------------------------------------------------------------------
  const controlsWithin = (el) => [...el.querySelectorAll("input, textarea, select")].filter((c) => isControl(c) && !hidden(c));
  // a group of controls: 2+ controls as children, or one wrapper level down (label > input), no headings inside
  const looksLikeControlGroup = (el) => {
    if (el.querySelector("h1, h2, h3, h4, h5, h6")) return false;
    let n = 0;
    for (const c of el.children) {
      if (isControl(c)) n++;
      else if (/^(LABEL|DIV|P|SPAN|FIELDSET)$/.test(c.tagName)) n += [...c.children].filter(isControl).length;
    }
    return n >= 2;
  };
  const labelFor = (c) => {
    const lab = c.labels && [...c.labels].map((l) => clean(textOf(l))).find(Boolean);
    if (lab) return { label: lab, source: "label" };
    const by = clean(c.getAttribute("aria-labelledby"));
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
      if (t) return { label: t, source: "aria-labelledby" };
    }
    if (clean(c.getAttribute("aria-label"))) return { label: clean(c.getAttribute("aria-label")), source: "aria-label" };
    if (clean(c.getAttribute("title"))) return { label: clean(c.getAttribute("title")), source: "title" };
    if (clean(c.getAttribute("placeholder"))) return { label: clean(c.getAttribute("placeholder")), source: "placeholder" };
    if (c.tagName === "SELECT") {
      const first = clean(c.options[0]?.textContent);
      if (/^(select|choose|pick|--)/i.test(first)) return { label: first, source: "first-option" };
    }
    return { label: "", source: "none" };
  };
  const extractForm = (el) => {
    const fields = controlsWithin(el).map((c) => {
      const type = c.tagName === "INPUT" ? (c.type || "text").toLowerCase() : c.tagName.toLowerCase();
      const { label, source } = labelFor(c);
      const field = { type, label, name: c.getAttribute("name") || null, labelSource: source };
      if (c.tagName === "SELECT") {
        field.options = [...c.options]
          .filter((o, i) => !(i === 0 && (o.value === "" || /^(select|choose|pick|--)/i.test(clean(o.textContent)))))
          .map((o) => clean(o.textContent));
      }
      return field;
    });
    let submit = el.querySelector('button[type="submit"], input[type="submit"]');
    if (!submit) submit = [...el.querySelectorAll("button")].find((b) => accName(b));
    return { fields, submitLabel: submit ? accName(submit) || null : null };
  };

  // ---- card groups: 2+ siblings with the same tag and class, each holding a short title or text ----
  const sig = (el) => el.tagName + "." + [...el.classList].sort().join(".");
  const cardGroups = (parent) => {
    const groups = new Map();
    for (const c of parent.children) {
      if (!ITEM_TAGS.has(c.tagName) || c === headerEl || c === footerEl || hidden(c)) continue;
      if (c.querySelector("h1, h2") || controlsWithin(c).length) continue;
      const len = textOf(c).length;
      if (len < 1 || len > 400) continue;
      const k = sig(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    return [...groups.values()].filter((g) => g.length >= 2);
  };
  const cardItem = (item) => {
    const h = item.querySelector("h3, h4, h5, h6, strong, b");
    const p = item.querySelector("p");
    const full = textOf(item);
    let title = clean(h?.textContent);
    let text = p ? textOf(p) : "";
    if (!title) {
      if (full.length <= 80) title = full;
      else {
        const cut = full.search(/[.!?]\s/);
        title = cut > 0 && cut <= 100 ? full.slice(0, cut + 1) : full.slice(0, 70).replace(/\s+\S*$/, "") + "...";
        text = text || clean(full.slice(title.length));
      }
    } else if (!text) {
      text = clean(full.replace(title, ""));
    }
    return { title, text };
  };

  // ---- note / callout detection ------------------------------------------------------------------
  const parseRgba = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const effectiveBg = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = parseRgba(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  // own background (different from what is behind it) or own border
  const hasBox = (el) => {
    const cs = getComputedStyle(el);
    const bg = parseRgba(cs.backgroundColor);
    if (bg && bg.a > 0) {
      const behind = el.parentElement ? effectiveBg(el.parentElement) : { r: 255, g: 255, b: 255 };
      if (bg.r !== behind.r || bg.g !== behind.g || bg.b !== behind.b) return true;
    }
    return ["Top", "Right", "Bottom", "Left"].some(
      (side) => parseFloat(cs["border" + side + "Width"]) > 0 && !["none", "hidden"].includes(cs["border" + side + "Style"])
    );
  };
  // a block of its own, not an inline fragment inside a paragraph, list item or table cell
  const standalone = (el) => getComputedStyle(el).display !== "inline" && !(el.parentElement && el.parentElement.closest("p, li, blockquote, td, th"));
  const bodyFont = parseFloat(getComputedStyle(body).fontSize) || 16;
  const isMuted = (el) =>
    el.tagName === "SMALL" ||
    /(^|[\s_-])(muted|note|small|caption|meta|updated|disclaimer|fine-?print|hint)([\s_-]|$)/i.test(el.className) ||
    parseFloat(getComputedStyle(el).fontSize) <= bodyFont * 0.9;
  // callout: short, standalone, with its own background or border. note: short and visually muted.
  const classify = (el, text) => {
    if (text.length <= 200 && standalone(el) && hasBox(el)) return "callout";
    if (text.length <= 160 && isMuted(el)) return "note";
    return "para";
  };

  // ---- walk the content in document order, producing atoms ---------------------------------
  const atoms = [];
  const walk = (el) => {
    if (SKIP.has(el.tagName) || el === headerEl || el === footerEl || el.tagName === "NAV" || hidden(el)) return;
    if (/^H[1-6]$/.test(el.tagName)) {
      const t = textOf(el);
      if (t) atoms.push({ t: "heading", level: Number(el.tagName[1]), text: t, el });
      return;
    }
    if (el.tagName === "FORM" || (el !== body && looksLikeControlGroup(el))) {
      atoms.push({ t: "form", el, ...extractForm(el) });
      return;
    }
    if (isControl(el) || el.tagName === "BUTTON") return;
    const hasBlockChild = [...el.children].some((c) => BLOCK.test(c.tagName) && !hidden(c));
    if (!hasBlockChild) {
      const t = textOf(el);
      if (t) atoms.push({ t: classify(el, t), text: t, el });
      return;
    }
    const first = new Map();
    const member = new Set();
    for (const g of cardGroups(el)) {
      first.set(g[0], g);
      g.forEach((i) => member.add(i));
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 1) {
        if (member.has(n)) {
          if (first.has(n)) atoms.push({ t: "cards", el: n, items: first.get(n).map(cardItem).filter((i) => i.title) });
        } else walk(n);
      } else if (n.nodeType === 3 && clean(n.textContent)) {
        atoms.push({ t: "para", text: clean(n.textContent), el });
      }
    }
  };
  walk(body);

  // ---- group atoms into sections -----------------------------------------------------------------
  const sections = [];
  const buttonLike = (b) => {
    if (b.tagName === "BUTTON" || b.getAttribute("role") === "button") return !!accName(b);
    return b.tagName === "A" && /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(b.className) && !!accName(b);
  };
  const HERO_HINT = /hero|banner|jumbotron|masthead|splash|intro/i;
  let i = 0;
  const firstAtom = atoms[0];
  if (firstAtom?.t === "heading") {
    const box = firstAtom.el.parentElement;
    const heroish = firstAtom.level === 1 || (firstAtom.level <= 3 && box && HERO_HINT.test(box.className + " " + box.id));
    if (heroish) {
      const next = atoms[1];
      const sub = next?.t === "para" && next.text.length <= 300 ? next.text : null;
      const buttons =
        box && box !== body
          ? [...box.querySelectorAll("a, button, [role=button]")].filter(buttonLike).map((b) => ({ label: accName(b), url: b.getAttribute("href") }))
          : [];
      sections.push({ kind: "hero", heading: firstAtom.text, subheading: sub, buttons, _el: firstAtom.el });
      i = sub ? 2 : 1;
    }
  }
  let pending = null; // { heading, paragraphs, els, el }
  const flush = () => {
    if (pending && (pending.heading || pending.paragraphs.length)) {
      sections.push({ kind: "prose", heading: pending.heading, paragraphs: pending.paragraphs, _el: pending.el });
    }
    pending = null;
  };
  // Cards and forms take the heading above them and its first paragraph as intro. Any further
  // paragraphs stay behind as their own prose section (placed by document order). Without a
  // heading, the loose paragraphs are flushed as prose and the section gets no heading.
  const takeHeading = () => {
    if (pending && pending.heading) {
      const [intro = null, ...extra] = pending.paragraphs;
      if (extra.length) sections.push({ kind: "prose", heading: null, paragraphs: extra, _el: pending.els[1] });
      const r = { heading: pending.heading, intro, el: pending.el };
      pending = null;
      return r;
    }
    flush();
    return { heading: null, intro: null, el: null };
  };
  for (; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.t === "heading") {
      flush();
      pending = { heading: a.text, paragraphs: [], els: [], el: a.el };
    } else if (a.t === "para") {
      if (!pending) pending = { heading: null, paragraphs: [], els: [], el: a.el };
      pending.paragraphs.push(a.text);
      pending.els.push(a.el);
    } else if (a.t === "note" || a.t === "callout") {
      sections.push({ kind: a.t, text: a.text, _el: a.el }); // standalone, never merged into prose
    } else if (a.t === "cards") {
      const h = takeHeading();
      if (a.items.length) sections.push({ kind: "cards", heading: h.heading, intro: h.intro, items: a.items, _el: h.el || a.el });
    } else if (a.t === "form") {
      const h = takeHeading();
      sections.push({ kind: "form", heading: h.heading, intro: h.intro, fields: a.fields, submitLabel: a.submitLabel, _el: h.el || a.el });
    }
  }
  flush();

  // ---- header / footer sections ------------------------------------------------------------------
  if (headerEl) {
    const nav = headerEl.tagName === "NAV" ? headerEl : headerEl.querySelector("nav");
    const siteTitle =
      clean(headerEl.querySelector(".site-name, .site-title, .logo-text, [class*=brand]")?.textContent) ||
      clean(headerEl.querySelector("img[alt]")?.getAttribute("alt")) ||
      clean(document.title) ||
      clean(document.querySelector("h1")?.textContent);
    sections.push({ kind: "header", nav: nav ? links(nav) : [], siteTitle, _el: headerEl });
  }
  if (footerEl) {
    sections.push({ kind: "footer", text: textOf(footerEl), links: links(footerEl), _el: footerEl });
  }

  // document order, then drop the helper element
  sections.sort((a, b) => {
    if (a._el === b._el) return 0;
    const pos = a._el.compareDocumentPosition(b._el);
    return pos & 4 ? -1 : pos & 2 ? 1 : 0;
  });
  return sections.map(({ _el, ...rest }) => rest);
}

export async function detectStructure(htmlPath) {
  const file = path.resolve(htmlPath);
  if (!fs.existsSync(file)) throw new Error(`HTML file not found: ${file}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 15000 });
    return await page.evaluate(detectInPage);
  } finally {
    await browser.close();
  }
}

// ---- report ------------------------------------------------------------------------------------------
const q = (s) => (s ? `"${s}"` : "(none)");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function describe(s) {
  switch (s.kind) {
    case "header":
      return [`header   site title ${q(s.siteTitle)}, ${plural(s.nav.length, "nav link")}`, ...s.nav.map((n) => `    - ${n.label} -> ${n.url}`)];
    case "hero":
      return [
        `hero     ${q(s.heading)}`,
        `    subheading: ${q(s.subheading)}`,
        `    buttons: ${s.buttons.length ? s.buttons.map((b) => `${q(b.label)} -> ${b.url ?? "(button)"}`).join(", ") : "none"}`,
      ];
    case "prose":
      return [`prose    ${q(s.heading)}: ${plural(s.paragraphs.length, "paragraph")}`, ...s.paragraphs.map((p) => `    - ${p.length > 70 ? p.slice(0, 67) + "..." : p}`)];
    case "cards":
      return [
        `cards    ${q(s.heading)}: ${plural(s.items.length, "item")}${s.intro ? `, intro ${q(s.intro)}` : ""}`,
        ...s.items.map((i) => `    - ${i.title}${i.text ? `: ${i.text.slice(0, 60)}` : ""}`),
      ];
    case "form":
      return [
        `form     ${q(s.heading)}: ${plural(s.fields.length, "field")}, submit ${q(s.submitLabel)}`,
        ...s.fields.map(
          (f) => `    - ${f.type.padEnd(8)} label ${q(f.label)} [${f.labelSource}], name: ${f.name ? q(f.name) : "MISSING (no name attribute)"}${f.options ? `, options: ${f.options.join(" | ")}` : ""}`
        ),
      ];
    case "note":
      return [`note     ${q(s.text)}`];
    case "callout":
      return [`callout  ${q(s.text)}`];
    case "footer":
      return [`footer   ${q(s.text)}, ${plural(s.links.length, "link")}`, ...s.links.map((l) => `    - ${l.label} -> ${l.url}`)];
    default:
      return [`${s.kind}`];
  }
}

// One-line counts, e.g. "header: 4 nav links | hero | prose: 3 paragraphs | cards: 3 items | form: 4 fields | footer"
export function summarize(sections) {
  return sections
    .map((s) =>
      s.kind === "header" ? `header: ${plural(s.nav.length, "nav link")}`
      : s.kind === "prose" ? `prose: ${plural(s.paragraphs.length, "paragraph")}`
      : s.kind === "cards" ? `cards: ${plural(s.items.length, "item")}`
      : s.kind === "form" ? `form: ${plural(s.fields.length, "field")}`
      : s.kind === "footer" ? `footer: ${plural(s.links.length, "link")}`
      : s.kind === "note" || s.kind === "callout" ? s.kind
      : s.kind === "hero" ? `hero: ${plural(s.buttons.length, "button")}`
      : s.kind
    )
    .join(" | ");
}

export function formatReport(sections) {
  const lines = [`Detected ${plural(sections.length, "section")} in document order:`, ""];
  sections.forEach((s, n) => {
    const [first, ...rest] = describe(s);
    lines.push(`${String(n + 1).padStart(2)}. ${first}`, ...rest);
  });
  lines.push("", `Summary: ${summarize(sections)}`);
  return lines.join("\n");
}

export function report(sections) {
  console.log(formatReport(sections));
}

// ---- CLI -----------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const htmlPath = process.argv[2];
  if (!htmlPath) {
    console.error("Usage: node structure.mjs <htmlPath>");
    process.exit(1);
  }
  try {
    report(await detectStructure(htmlPath));
  } catch (e) {
    console.error("structure detection failed:", e.message);
    process.exit(1);
  }
}
