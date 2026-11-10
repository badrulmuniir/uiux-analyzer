import { chromium, errors } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT = 15000;

const AXE_RULES = [
  'html-has-lang', 'document-title', 'image-alt', 'label', 'button-name',
  'link-name', 'meta-viewport', 'color-contrast', 'heading-order',
  'page-has-heading-one', 'empty-heading', 'target-size',
];

const WCAG = {
  'html-has-lang': '3.1.1',
  'document-title': '2.4.2',
  'image-alt': '1.1.1',
  'label': '1.3.1',
  'button-name': '4.1.2',
  'link-name': '4.1.2',
  'meta-viewport': '1.4.4',
  'color-contrast': '1.4.3',
  'heading-order': '1.3.1',
  'page-has-heading-one': '1.3.1',
  'empty-heading': '2.4.6',
  'target-size': '2.5.8',
  'focus-visible': '2.4.7',
  'text-spacing': '1.4.12',
  'line-height': '1.4.8',
  'duplicate-id': '1.3.1 / 4.1.2',
  'placeholder-only-label': '1.3.1 / 3.3.2',
};

class AnalyzeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  console.log(JSON.stringify({ status: 'failed', error: code, message }, null, 2));
  process.exit(1);
}

function makeResult(id, source, impact, help, nodes) {
  return { id, source, impact, wcag: WCAG[id] ?? null, help, nodes };
}

function fromAxe(v) {
  return makeResult(
    v.id, 'axe', v.impact, v.help,
    v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html, detail: n.failureSummary }))
  );
}

// ---- Code below runs inside the page ------------------------------------

function installHelpers() {
  const cssPath = (el) => {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      let part = cur.localName;
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c));
      if (cls.length) part += '.' + cls.join('.');
      const sibs = cur.parentElement
        ? [...cur.parentElement.children].filter((s) => s.localName === cur.localName)
        : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ') || 'html';
  };
  const snippet = (el) => {
    const html = el.outerHTML;
    const open = html.slice(0, html.indexOf('>') + 1) || html;
    return open.length > 250 ? open.slice(0, 250) + '...' : open;
  };
  const node = (el, detail) => ({ target: cssPath(el), html: snippet(el), detail });
  const focusStyle = (el) => {
    const cs = getComputedStyle(el);
    const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    return JSON.stringify({
      outline: hasOutline ? [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.outlineOffset] : 'none',
      boxShadow: cs.boxShadow,
    });
  };
  window.__h = { cssPath, snippet, node, focusStyle };
}

function runStaticChecks() {
  const { node } = window.__h;
  const out = [];

  // placeholder-only-label
  const nonEmpty = (s) => s != null && s.trim() !== '';
  const fields = [...document.querySelectorAll('input[placeholder], textarea[placeholder]')].filter(
    (el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((el.type || '').toLowerCase())
  );
  const unlabeled = fields.filter((el) => {
    if (nonEmpty(el.getAttribute('aria-label'))) return false;
    const lb = el.getAttribute('aria-labelledby');
    if (nonEmpty(lb) && lb.split(/\s+/).some((id) => {
      const ref = document.getElementById(id);
      return ref && nonEmpty(ref.textContent);
    })) return false;
    if (el.labels && [...el.labels].some((l) => nonEmpty(l.textContent))) return false;
    return true;
  });
  if (unlabeled.length) {
    out.push({
      id: 'placeholder-only-label',
      impact: 'serious',
      help: 'Form fields must not rely on placeholder text as their only label',
      nodes: unlabeled.map((el) =>
        node(el, `Field has placeholder "${el.getAttribute('placeholder')}" but no <label>, aria-label or aria-labelledby`)),
    });
  }

  // duplicate-id
  const byId = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    if (!el.id) continue;
    if (!byId.has(el.id)) byId.set(el.id, []);
    byId.get(el.id).push(el);
  }
  const dupNodes = [];
  for (const [id, els] of byId) {
    if (els.length < 2) continue;
    for (const el of els) dupNodes.push(node(el, `id "${id}" is used by ${els.length} elements`));
  }
  if (dupNodes.length) {
    out.push({
      id: 'duplicate-id',
      impact: 'moderate',
      help: 'id attribute values must be unique',
      nodes: dupNodes,
    });
  }

  // line-height: paragraphs with their own text must have line-height >= 1.5 x font-size
  const lhNodes = [];
  for (const p of document.querySelectorAll('p')) {
    const hasText = [...p.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!hasText) continue;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const fs = parseFloat(cs.fontSize);
    if (cs.lineHeight === 'normal') {
      lhNodes.push(node(p, `line-height is "normal" (about 1.2 x font-size, ${fs}px); needs at least 1.5`));
      continue;
    }
    const lh = parseFloat(cs.lineHeight);
    if (lh < fs * 1.5 - 0.01) {
      lhNodes.push(node(p, `line-height ${lh}px is ${(lh / fs).toFixed(2)} x font-size (${fs}px); needs at least 1.5`));
    }
  }
  if (lhNodes.length) {
    out.push({
      id: 'line-height',
      impact: 'minor',
      help: 'Paragraph line height should be at least 1.5 times the font size',
      nodes: lhNodes,
    });
  }

  return out;
}

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

function recordFocusBaseline(selector) {
  const { focusStyle } = window.__h;
  window.__fvBase = new Map();
  const els = [...document.querySelectorAll(selector)];
  for (const el of els) window.__fvBase.set(el, focusStyle(el));
  return els.length;
}

// Called after each Tab press; returns the active element's key info, or null.
function inspectActive() {
  const { focusStyle } = window.__h;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  window.__fvSeen = window.__fvSeen || new Set();
  if (window.__fvSeen.has(el)) return { cycled: true };
  window.__fvSeen.add(el);
  const before = window.__fvBase.get(el);
  const after = focusStyle(el);
  if (before === undefined || before !== after) return { cycled: false, indicator: true };
  return { cycled: false, indicator: false, node: window.__h.node(el, `No visible change in outline or box-shadow when focused (${after})`) };
}

function injectTextSpacing() {
  const clipped = (el) => {
    const cs = getComputedStyle(el);
    return ['hidden', 'clip'].includes(cs.overflowY) && el.clientHeight > 0 && el.scrollHeight > el.clientHeight;
  };
  window.__tsBefore = new Set([...document.querySelectorAll('body *')].filter(clipped));
  const style = document.createElement('style');
  style.id = '__text_spacing_probe';
  style.textContent =
    '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }' +
    ' p { margin-bottom: 2em !important; }';
  document.head.appendChild(style);
}

function collectTextSpacing() {
  const clipped = (el) => {
    const cs = getComputedStyle(el);
    return ['hidden', 'clip'].includes(cs.overflowY) && el.clientHeight > 0 && el.scrollHeight > el.clientHeight;
  };
  const nodes = [...document.querySelectorAll('body *')]
    .filter((el) => clipped(el) && !window.__tsBefore.has(el) && el.textContent.trim() !== '')
    .map((el) => window.__h.node(el, `Text is clipped under WCAG text spacing (scrollHeight ${el.scrollHeight}px > clientHeight ${el.clientHeight}px)`));
  document.getElementById('__text_spacing_probe')?.remove();
  return nodes;
}

// ---- Node side ----------------------------------------------------------

async function checkFocusVisible(page) {
  const count = await page.evaluate(recordFocusBaseline, FOCUSABLE);
  const nodes = [];
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < count + 1; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(inspectActive);
    if (r === null) continue;
    if (r.cycled) break;
    if (!r.indicator) nodes.push(r.node);
  }
  return nodes.length
    ? [{
        id: 'focus-visible',
        impact: 'serious',
        help: 'Keyboard focus must have a visible indicator',
        nodes,
      }]
    : [];
}

async function checkTextSpacing(page) {
  await page.evaluate(injectTextSpacing);
  const nodes = await page.evaluate(collectTextSpacing);
  return nodes.length
    ? [{
        id: 'text-spacing',
        impact: 'serious',
        help: 'Content must not be clipped when text spacing is increased',
        nodes,
      }]
    : [];
}

async function analyze(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new AnalyzeError('NO_HTML', `File not found: ${file}`);
  }
  if (!stat.isFile()) throw new AnalyzeError('NO_HTML', `Not a file: ${file}`);

  const url = pathToFileURL(path.resolve(file)).href;
  const browser = await chromium.launch({ headless: true });
  let timer;
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    await context.route('**/*', (route) =>
      route.request().url().startsWith('file://') ? route.continue() : route.abort()
    );

    const page = await context.newPage();
    const crashed = new Promise((_, reject) =>
      page.on('crash', () => reject(new AnalyzeError('RENDER_CRASH', 'Page crashed while rendering')))
    );
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new AnalyzeError('RENDER_TIMEOUT', `Analysis exceeded ${TIMEOUT / 1000}s`)),
        TIMEOUT
      );
    });

    const work = (async () => {
      await page.goto(url, { waitUntil: 'load' });
      const axe = await new AxeBuilder({ page }).withRules(AXE_RULES).analyze();
      await page.evaluate(installHelpers);
      const staticChecks = await page.evaluate(runStaticChecks);
      const focus = await checkFocusVisible(page);
      const spacing = await checkTextSpacing(page); // last: it injects CSS
      const custom = [...staticChecks, ...focus, ...spacing].map((c) =>
        makeResult(c.id, 'custom', c.impact, c.help, c.nodes));
      return [...axe.violations.map(fromAxe), ...custom];
    })();

    return await Promise.race([work, crashed, timedOut]);
  } catch (err) {
    if (err instanceof AnalyzeError) throw err;
    if (err instanceof errors.TimeoutError) throw new AnalyzeError('RENDER_TIMEOUT', err.message);
    throw new AnalyzeError('RENDER_CRASH', err.message);
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
  }
}

const file = process.argv[2];
if (!file) fail('NO_HTML', 'Usage: node analyze.mjs <path-to-html>');

try {
  const violations = await analyze(file);
  console.log(JSON.stringify(violations, null, 2));
} catch (err) {
  if (err instanceof AnalyzeError) fail(err.code, err.message);
  fail('RENDER_CRASH', err.message);
}
