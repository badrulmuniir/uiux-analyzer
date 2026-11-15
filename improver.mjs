import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { evaluate, runAnalyzer } from './evaluate.mjs';

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';

export const HTML_RULES = [
  'html-has-lang', 'document-title', 'image-alt', 'label', 'placeholder-only-label',
  'button-name', 'link-name', 'meta-viewport', 'heading-order', 'page-has-heading-one',
  'empty-heading', 'duplicate-id',
];
export const CSS_RULES = ['color-contrast', 'focus-visible', 'target-size', 'line-height', 'text-spacing'];

const HTML_PASS_RULES = `- Fix ALL listed issues. Edits may only target .html files.
- Alt text must describe the image briefly. Use alt="" only for clearly decorative images. Do not invent descriptions; only use context from the page text near the image.`;

const CSS_PASS_RULES = `- Fix ALL listed issues. Edits may only target .css files, the <style> block inside .html files, or inline style="" attributes on elements.
- color-contrast: change only the color value so contrast is at least 4.5:1.
- focus-visible: add a rule like :focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; } and remove outline:none.
- target-size: set min-width and min-height to 24px on the affected selector.
- line-height: set line-height: 1.5 on the affected selector.
- text-spacing: remove the fixed height or overflow:hidden that clips text.`;

function buildPrompt(issues, files, feedback, pass = 'html') {
  const fileText = Object.entries(files)
    .map(([name, content]) => `=== FILE: ${name} ===\n${content}`)
    .join('\n\n');
  return `You fix accessibility issues in a website. Return ONLY JSON, no prose, no markdown fences, in exactly this shape:
{"edits":[{"file":"index.html","find":"<exact text>","replace":"<new text>"}]}

Rules:
- "find" must be copied exactly from the file and occur exactly once in that file (include enough surrounding text to be unique).
- Each fix must be a small, targeted search/replace edit. Do not restructure, reformat, or reindent the file.
- Do not change any line that is not directly related to a listed issue.
${pass === 'css' ? CSS_PASS_RULES : HTML_PASS_RULES}
${feedback ? `\nFeedback from previous attempt:\n${feedback}\n` : ''}
Issues:
${JSON.stringify(issues, null, 2)}

${fileText}`;
}

export async function improve(issues, files, feedback = '', pass = 'html') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const params = {
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: buildPrompt(issues, files, feedback, pass) }],
  };
  let res;
  try {
    res = await client.messages.create({ ...params, temperature: 0 });
  } catch (e) {
    // Some newer models reject the temperature parameter; retry without it.
    if (e.status === 400 && /temperature/i.test(e.message)) {
      res = await client.messages.create(params);
    } else {
      throw e;
    }
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error(`Failed to parse model output as JSON: ${e.message}\n${text}`);
    err.code = 'PARSE';
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.edits)) {
    const err = new Error('Model output missing "edits" array');
    err.code = 'PARSE';
    throw err;
  }

  const edits = [];
  for (const [i, e] of parsed.edits.entries()) {
    if (!e || typeof e.file !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string') {
      console.warn(`Warning: dropping edit ${i}: file/find/replace must be strings`);
      continue;
    }
    const content = files[e.file];
    if (content === undefined) {
      console.warn(`Warning: dropping edit ${i}: unknown file "${e.file}"`);
      continue;
    }
    const count = e.find === '' ? 0 : content.split(e.find).length - 1;
    if (count !== 1) {
      console.warn(`Warning: dropping edit ${i}: "find" occurs ${count} times in ${e.file} (need exactly 1)`);
      continue;
    }
    edits.push({ file: e.file, find: e.find, replace: e.replace });
  }
  return { edits };
}

function applyEdit(content, e) {
  const idx = content.indexOf(e.find);
  return content.slice(0, idx) + e.replace + content.slice(idx + e.find.length);
}

// Ranges of CSS inside the content: <style> blocks and inline style="" attribute values.
function cssRanges(content) {
  const blocks = [];
  for (const m of content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1;
    blocks.push({ kind: 'style-block', start, end: start + m[1].length });
  }
  const inline = [];
  for (const m of content.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const start = m.index + m[0].indexOf(m[1]) + 1;
    inline.push({ kind: 'inline-style', start, end: start + m[1].length - 2 });
  }
  return { blocks, inline };
}

// Checked against `content` = file text AFTER pass 1 edits were applied.
function findCssRange(content, find) {
  const idx = content.indexOf(find);
  const { blocks, inline } = cssRanges(content);
  const hit = [...blocks, ...inline].find((r) => idx >= r.start && idx + find.length <= r.end);
  return { hit, blocks, inline, idx };
}

export async function improveAll(issues, files, feedback = '') {
  const htmlIssues = issues.filter((i) => HTML_RULES.includes(i.id));
  const cssIssues = issues.filter((i) => CSS_RULES.includes(i.id));
  const work = { ...files }; // in-memory copy; never written to disk

  let pass1 = [];
  if (htmlIssues.length) {
    const r = await improve(htmlIssues, work, feedback, 'html');
    for (const e of r.edits) {
      if (!/\.html?$/i.test(e.file)) {
        console.warn(`Warning: dropping pass 1 edit: ${e.file} is not an .html file`);
        continue;
      }
      pass1.push(e);
      work[e.file] = applyEdit(work[e.file], e);
    }
  }

  const pass2 = [];
  if (cssIssues.length) {
    const r = await improve(cssIssues, work, feedback, 'css');
    for (const e of r.edits) {
      const isCss = /\.css$/i.test(e.file);
      const isHtml = /\.html?$/i.test(e.file);
      if (!isCss && !isHtml) {
        console.warn(`Warning: dropping pass 2 edit: ${e.file} is not .css or .html`);
        continue;
      }
      const content = work[e.file];
      const count = content === undefined || e.find === '' ? 0 : content.split(e.find).length - 1;
      if (count !== 1) {
        console.warn(`Warning: dropping pass 2 edit: "find" occurs ${count} times in ${e.file} after pass 1`);
        continue;
      }
      if (isHtml) {
        const { hit, blocks, inline, idx } = findCssRange(content, e.find);
        if (!hit) {
          console.warn(`Warning: dropping pass 2 edit: change in ${e.file} is outside <style> blocks and inline style="" attributes`);
          console.warn(`  find:    ${JSON.stringify(e.find)}`);
          console.warn(`  replace: ${JSON.stringify(e.replace)}`);
          console.warn(`  find position (post-pass-1 content): ${idx}-${idx + e.find.length}`);
          console.warn(`  <style> blocks checked: ${blocks.map((b) => `${b.start}-${b.end}`).join(', ') || 'none'}`);
          console.warn(`  inline style attrs checked: ${inline.length}`);
          continue;
        }
      }
      pass2.push(e);
      work[e.file] = applyEdit(content, e);
    }
  }
  return { edits: [...pass1, ...pass2] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'sample/';
  const entryName = process.argv[3] || 'index.html';
  const { issues } = evaluate(runAnalyzer(path.join(dir, entryName)));
  const files = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(html?|css|js)$/i.test(ent.name)) {
        files[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  try {
    const result = await improveAll(issues, files);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(e.code === 'PARSE' ? 1 : 2);
  }
}
