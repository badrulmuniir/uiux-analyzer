// Content import: pull the user's own content out of their HTML and show a generated theme with it.
// CLI: node content-import.mjs <htmlPath> <themeDir> <slug> [out.png]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startPlayground, stopServer, freePort, readLog, sleep, q } from "./validate-theme.mjs";

// ---- 1. extraction (runs inside the page, so a real DOM does the parsing) ---------------------
function extractInPage() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const SKIP_TAGS = new Set([
    "NAV", "HEADER", "FOOTER", "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "FORM", "SELECT", "TEXTAREA",
    "INPUT", "BUTTON", "OPTION", "LABEL", "IFRAME", "TEMPLATE", "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS",
  ]);
  const SKIP_ROLES = new Set(["banner", "navigation", "contentinfo"]);
  const BLOCK = /^(DIV|SECTION|ARTICLE|MAIN|ASIDE|UL|OL|LI|BLOCKQUOTE|DL|DD|DT|TABLE|THEAD|TBODY|TR|TD|TH|P|H[1-6]|PRE|FIGURE|DETAILS|SUMMARY)$/;

  const skipped = (el) => {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    if (SKIP_ROLES.has((el.getAttribute("role") || "").toLowerCase())) return true;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  };
  // visible text of an element, ignoring controls, scripts, nav etc. inside it
  const textOf = (el) => {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent + " ";
      else if (n.nodeType === 1 && !skipped(n)) out += textOf(n) + " ";
    }
    return clean(out);
  };
  const insideSkipped = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) if (skipped(e)) return true;
    return false;
  };

  // site title: <title>, else .site-name, h1, logo alt
  const siteTitle =
    clean(document.title) ||
    clean(document.querySelector(".site-name, .site-title, .logo-text")?.textContent) ||
    clean(document.querySelector("h1")?.textContent) ||
    clean(document.querySelector("header img[alt], .logo img[alt], img.logo[alt]")?.getAttribute("alt")) ||
    "";

  // main nav links
  const nav = document.querySelector("header nav, nav");
  const navItems = nav
    ? [...nav.querySelectorAll("a[href]")]
        .map((a) => ({ label: clean(a.textContent) || clean(a.getAttribute("aria-label")), url: a.getAttribute("href") }))
        .filter((i) => i.label)
    : [];

  // posts: 3+ sibling items sharing a tag+class (cards, list items, repeated sections), outermost first
  const consumed = new Set();
  const posts = [];
  const sig = (el) => el.tagName + "." + [...el.classList].sort().join(".");
  const ITEM_TAGS = new Set(["DIV", "LI", "ARTICLE", "SECTION"]);
  const all = [...document.body.querySelectorAll("*")];
  for (const parent of all) {
    if (insideSkipped(parent) || skipped(parent)) continue;
    if ([...consumed].some((c) => c.contains(parent))) continue;
    const groups = new Map();
    for (const c of parent.children) {
      if (!ITEM_TAGS.has(c.tagName) || skipped(c)) continue;
      const k = sig(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    for (const items of groups.values()) {
      if (items.length < 3) continue;
      // sections that carry h1/h2 headings are pages, not posts; very long items are not cards
      if (items.some((i) => i.querySelector("h1, h2") || textOf(i).length > 600)) continue;
      const found = items
        .map((item) => {
          const h = item.querySelector("h3, h4, h5, h6, strong, b");
          const para = item.querySelector("p");
          let title = clean(h?.textContent);
          let excerpt = clean(para ? textOf(para) : "");
          const full = textOf(item);
          if (!title) {
            if (full.length <= 80) title = full;
            else {
              const cut = full.search(/[.!?]\s/);
              title = cut > 0 && cut <= 100 ? full.slice(0, cut + 1) : full.slice(0, 70).replace(/\s+\S*$/, "") + "...";
              excerpt = excerpt || clean(full.slice(title.length));
            }
          } else if (!excerpt) {
            excerpt = clean(full.replace(title, ""));
          }
          return { item, title, excerpt };
        })
        .filter((p) => p.title);
      if (found.length < 3) continue;
      for (const f of found) {
        consumed.add(f.item);
        posts.push({ title: f.title, excerpt: f.excerpt });
      }
    }
  }

  // linear walk of the remaining content: headings and paragraphs, skipping nav/header/footer
  const blocks = [];
  const walk = (el) => {
    if (skipped(el) || consumed.has(el)) return;
    const tag = el.tagName.toUpperCase();
    if (/^H[1-6]$/.test(tag)) {
      const t = textOf(el);
      if (t) blocks.push({ type: "heading", level: Number(tag[1]), text: t });
      return;
    }
    const hasBlockChild = [...el.children].some((c) => BLOCK.test(c.tagName.toUpperCase()) && !skipped(c));
    if (!hasBlockChild) {
      const t = textOf(el);
      if (t) blocks.push({ type: "paragraph", text: t });
      return;
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 1) walk(n);
      else if (n.nodeType === 3 && clean(n.textContent)) blocks.push({ type: "paragraph", text: clean(n.textContent) });
    }
  };
  walk(document.body);

  // group by headings: the main heading (first h1, else the first heading before any h2) and every
  // h2 open a page; lower headings stay inside the page as heading blocks.
  const firstH1 = blocks.findIndex((b) => b.type === "heading" && b.level === 1);
  const firstH2 = blocks.findIndex((b) => b.type === "heading" && b.level === 2);
  const firstHeading = blocks.findIndex((b) => b.type === "heading");
  const mainIdx = firstH1 >= 0 ? firstH1 : firstHeading >= 0 && (firstH2 < 0 || firstHeading < firstH2) ? firstHeading : -1;
  const pages = [];
  let current = null;
  let tagline = null;
  blocks.forEach((b, i) => {
    if (b.type === "heading" && (i === mainIdx || b.level === 2)) {
      current = { title: b.text, blocks: [] };
      pages.push(current);
      return;
    }
    if (!current) {
      current = { title: siteTitle || "Home", blocks: [] };
      pages.push(current);
    }
    current.blocks.push(b);
  });
  if (mainIdx >= 0) {
    const mainPage = pages.find((p) => p.title === blocks[mainIdx].text);
    tagline = mainPage?.blocks.find((b) => b.type === "paragraph")?.text ?? null;
  }
  return { siteTitle, tagline, navItems, pages, posts };
}

export async function extractContent(htmlPath) {
  const file = path.resolve(htmlPath);
  if (!fs.existsSync(file)) throw new Error(`HTML file not found: ${file}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 15000 });
    return await page.evaluate(extractInPage);
  } finally {
    await browser.close();
  }
}

// ---- 2. blueprint ---------------------------------------------------------------------------------
// A blueprint cannot reach host folders, so the theme folder itself is mounted by the CLI
// (--auto-mount); the blueprint activates it and creates everything else.
export function buildBlueprint(content, themeDir, slug) {
  const payload = Buffer.from(JSON.stringify({ ...content, slug }), "utf8").toString("base64");
  const php = `<?php
require_once '/wordpress/wp-load.php';
kses_remove_filters();
wp_set_current_user(1);
$c = json_decode(base64_decode('${payload}'), true);
switch_theme($c['slug']);

update_option('blogname', $c['siteTitle'] ?: get_option('blogname'));
update_option('blogdescription', $c['tagline'] ?? '');

// remove the WordPress defaults so only the user's content shows
wp_delete_post(1, true);   // Hello world!
wp_delete_post(2, true);   // Sample Page

function blocks_to_markup($blocks) {
  $out = [];
  foreach ($blocks as $b) {
    $t = esc_html($b['text']);
    if ($b['type'] === 'heading') {
      $lvl = max(1, min(6, (int) $b['level']));
      $attr = $lvl === 2 ? '' : ' ' . json_encode(['level' => $lvl]);
      $out[] = "<!-- wp:heading$attr -->\\n<h$lvl class=\\"wp-block-heading\\">$t</h$lvl>\\n<!-- /wp:heading -->";
    } else {
      $out[] = "<!-- wp:paragraph -->\\n<p>$t</p>\\n<!-- /wp:paragraph -->";
    }
  }
  return implode("\\n\\n", $out);
}

$page_ids = [];
foreach ($c['pages'] as $p) {
  $id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => $p['title'],
    'post_content' => blocks_to_markup($p['blocks'])], true);
  if (!is_wp_error($id)) $page_ids[] = ['id' => $id, 'title' => $p['title']];
}
foreach ($c['posts'] as $i => $p) {
  $body = $p['excerpt'] !== '' ? blocks_to_markup([['type' => 'paragraph', 'text' => $p['excerpt']]]) : '';
  wp_insert_post(['post_type' => 'post', 'post_status' => 'publish', 'post_title' => $p['title'],
    'post_excerpt' => $p['excerpt'], 'post_content' => $body,
    'post_date' => gmdate('Y-m-d H:i:s', time() - $i * 60)], true);
}

// navigation: a wp_navigation post (the "menu" a block theme's Navigation block uses). Items whose
// label matches a created page link to it; "Home" links to the front page; the rest keep their URL.
$links = [];
foreach ($c['navItems'] as $n) {
  $label = $n['label']; $url = $n['url']; $lower = strtolower($label);
  if ($lower === 'home') { $url = home_url('/'); }
  else {
    foreach ($page_ids as $pg) {
      $pt = strtolower($pg['title']);
      if ($pt === $lower || strpos($pt, $lower) !== false || strpos($lower, $pt) !== false) { $url = get_permalink($pg['id']); break; }
    }
  }
  $links[] = '<!-- wp:navigation-link ' . json_encode(['label' => $label, 'type' => 'custom', 'url' => $url, 'kind' => 'custom', 'isTopLevelLink' => true], JSON_UNESCAPED_SLASHES) . ' /-->';
}
if ($links) {
  wp_insert_post(['post_type' => 'wp_navigation', 'post_status' => 'publish', 'post_title' => 'Main menu',
    'post_content' => implode("\\n", $links)]);
}

if ($page_ids) {
  update_option('show_on_front', 'page');
  update_option('page_on_front', $page_ids[0]['id']);
}
`;
  return {
    landingPage: "/",
    preferredVersions: { php: "8.3", wp: "latest" },
    steps: [{ step: "runPHP", code: php }],
  };
}

// ---- 3. preview with content -----------------------------------------------------------------------
// Start a Playground server with the theme mounted and the content imported, wait until the home
// page answers 200. Returns { url, content, stop } - stop() kills the whole server and cleans up.
export async function startContentServer(htmlPath, themeDir, slug) {
  const content = await extractContent(htmlPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "content-preview-"));
  const blueprintFile = path.join(tmp, "blueprint.json");
  const logFile = path.join(tmp, "server.log");
  fs.writeFileSync(blueprintFile, JSON.stringify(buildBlueprint(content, themeDir, slug)));

  const port = await freePort();
  const server = startPlayground(
    ["server", `--port=${port}`, `--auto-mount=${q(path.resolve(themeDir))}`, `--blueprint=${q(blueprintFile)}`],
    logFile
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopServer(server, port); // kill the tree and wait for the port to close
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
  };
  try {
    let url = null;
    let exited = false;
    server.exited.then(() => { exited = true; });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !exited) {
      const m = /Ready!.*?(http:\/\/127\.0\.0\.1:\d+)/.exec(readLog(logFile));
      if (m) { url = m[1] + "/"; break; }
      await sleep(500);
    }
    if (!url) throw new Error(`Playground server did not start: ${readLog(logFile).trim().slice(-400) || "(no output)"}`);

    let status = 0;
    for (let i = 0; i < 60 && status !== 200; i++) {
      try { status = (await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })).status; }
      catch { await sleep(1000); }
      if (status && status !== 200 && i >= 2) break;
    }
    if (status !== 200) throw new Error(`the site at ${url} returned HTTP ${status}`);
    return { url, content, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

export async function previewWithContent(htmlPath, themeDir, slug, outPng) {
  const { url, content, stop } = await startContentServer(htmlPath, themeDir, slug);
  try {
    fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const origin = new URL(url).origin;
      await context.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.screenshot({ path: outPng, fullPage: true, timeout: 30000 });
    } finally {
      await browser.close();
    }
    return {
      png: path.resolve(outPng),
      imported: {
        siteTitle: content.siteTitle,
        tagline: content.tagline,
        pages: content.pages.length,
        posts: content.posts.length,
        navItems: content.navItems.length,
      },
      content,
    };
  } finally {
    await stop(); // always
  }
}

// ---- 4. CLI -----------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const serve = argv.includes("--serve");
  const [htmlPath, themeDir, slug, out] = argv.filter((a) => !a.startsWith("--"));
  if (!htmlPath || !themeDir || !slug) {
    console.error("Usage: node content-import.mjs <htmlPath> <themeDir> <slug> [out.png] [--serve]");
    process.exit(1);
  }
  try {
    const content = await extractContent(htmlPath);
    console.log("Extracted:");
    console.log(`  site title: ${content.siteTitle || "(none)"}`);
    console.log(`  tagline:    ${content.tagline ?? "(none)"}`);
    console.log(`  nav items:  ${content.navItems.length}  ${content.navItems.map((n) => `${n.label} -> ${n.url}`).join(" | ")}`);
    console.log(`  pages:      ${content.pages.length}`);
    for (const p of content.pages) console.log(`    - "${p.title}" (${p.blocks.length} block${p.blocks.length === 1 ? "" : "s"}${p.blocks.length ? ": " + p.blocks.map((b) => (b.type === "heading" ? `h${b.level}` : "p")).join(",") : ""})`);
    console.log(`  posts:      ${content.posts.length}`);
    for (const p of content.posts) console.log(`    - "${p.title}"${p.excerpt ? `: ${p.excerpt.slice(0, 60)}` : ""}`);

    if (serve) {
      // --serve: no screenshot; leave the server running until Ctrl+C
      console.log("\nStarting Playground with the imported content...");
      const { url, stop } = await startContentServer(htmlPath, themeDir, slug);
      console.log(`\nServing at ${url}`);
      console.log("Press Ctrl+C to stop the server.");
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log("\nStopping server...");
        await stop();
        console.log("Server stopped.");
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {}); // keep the process alive; the signal handlers end it
    }

    console.log("\nStarting Playground and rendering the home page...");
    const result = await previewWithContent(htmlPath, themeDir, slug, out || path.join("previews", `${slug}-content.png`));
    console.log(`\nScreenshot: ${result.png}`);
    process.exit(0);
  } catch (e) {
    console.error("content import failed:", e.message);
    process.exit(1);
  }
}
