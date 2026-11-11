import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { evaluate, runAnalyzer } from './evaluate.mjs';

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';

function buildPrompt(issues, files, feedback) {
  const fileText = Object.entries(files)
    .map(([name, content]) => `=== FILE: ${name} ===\n${content}`)
    .join('\n\n');
  return `You fix accessibility issues in HTML. Return ONLY JSON, no prose, no markdown fences, in exactly this shape:
{"edits":[{"file":"index.html","find":"<exact text>","replace":"<new text>"}]}

Rules:
- "find" must be copied exactly from the file and occur exactly once in that file (include enough surrounding text to be unique).
- Fix the top 5 issues listed. Each fix must be a small, targeted search/replace edit. Do not restructure, reformat, or reindent the file.
- Do not change any line that is not directly related to a listed issue.
- Alt text must describe the image briefly. Decorative images may use alt="".
- If the image is decorative or its content cannot be determined from context, use alt="". Do not invent descriptions. Only use context from the page text near the image.
${feedback ? `\nFeedback from previous attempt:\n${feedback}\n` : ''}
Issues:
${JSON.stringify(issues, null, 2)}

${fileText}`;
}

export async function improve(issues, files, feedback = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const params = {
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: buildPrompt(issues, files, feedback) }],
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = path.join('sample', 'index.html');
  const { issues } = evaluate(runAnalyzer(entry));
  const imgIssues = issues.filter((i) => i.id === 'image-alt');
  const files = { 'index.html': fs.readFileSync(entry, 'utf8') };
  try {
    const result = await improve(imgIssues, files);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(e.code === 'PARSE' ? 1 : 2);
  }
}
