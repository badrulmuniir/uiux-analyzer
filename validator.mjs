import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, runAnalyzer } from './evaluate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function validate(edits, dir = 'sample', entry = 'index.html') {
  const srcDir = path.resolve(HERE, dir);
  const candDir = path.resolve(HERE, 'candidate');

  // Copy the sample folder to candidate (overwrite if it exists).
  fs.rmSync(candDir, { recursive: true, force: true });
  fs.cpSync(srcDir, candDir, { recursive: true });

  const editResults = [];
  for (const [i, e] of edits.entries()) {
    const label = `edit ${i + 1} (${e?.file})`;
    const reject = (reason) => {
      console.warn(`Warning: ${label} rejected: ${reason}`);
      editResults.push({ index: i, file: e?.file, applied: false, reason });
    };
    if (!e || typeof e.file !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string') {
      reject('file/find/replace must be strings');
      continue;
    }
    const target = path.resolve(candDir, e.file);
    if (!target.startsWith(candDir + path.sep)) { reject('file path escapes candidate folder'); continue; }
    if (!fs.existsSync(target)) { reject('file not found'); continue; }
    const content = fs.readFileSync(target, 'utf8');
    const count = e.find === '' ? 0 : content.split(e.find).length - 1;
    if (count !== 1) { reject(`"find" occurs ${count} times (need exactly 1)`); continue; }
    const idx = content.indexOf(e.find);
    fs.writeFileSync(target, content.slice(0, idx) + e.replace + content.slice(idx + e.find.length));
    editResults.push({ index: i, file: e.file, applied: true, reason: '' });
  }

  const before = evaluate(runAnalyzer(path.join(dir, entry)));
  const after = evaluate(runAnalyzer(path.join('candidate', entry)));
  const scoreBefore = before.score;
  const scoreAfter = after.score;

  const originalIds = new Set(before.issues.map((i) => i.id));
  const newCritical = after.issues.filter((i) => i.impact === 'critical' && !originalIds.has(i.id));

  const reasons = [];
  if (!(scoreAfter > scoreBefore)) reasons.push(`score did not improve (${scoreBefore} -> ${scoreAfter})`);
  if (newCritical.length) reasons.push(`new critical issue(s): ${newCritical.map((i) => i.id).join(', ')}`);
  const accepted = reasons.length === 0;

  return { accepted, scoreBefore, scoreAfter, reason: reasons.join('; '), editResults };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'improver.mjs')], {
    cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`improver.mjs failed (exit ${r.status}): ${r.stderr}`);
    process.exit(1);
  }
  let edits;
  try {
    edits = JSON.parse(r.stdout).edits;
    if (!Array.isArray(edits)) throw new Error('no edits array');
  } catch (e) {
    console.error(`Could not parse improver output: ${e.message}`);
    process.exit(1);
  }

  const res = validate(edits, 'sample', 'index.html');
  console.log(`Score before: ${res.scoreBefore}/100`);
  console.log(`Score after: ${res.scoreAfter}/100`);
  console.log(`Decision: ${res.accepted ? 'ACCEPTED' : 'REJECTED'}`);
  if (!res.accepted) console.log(`Reason: ${res.reason}`);
  for (const er of res.editResults) {
    console.log(`Edit ${er.index + 1} (${er.file}): ${er.applied ? 'APPLIED' : 'SKIPPED - ' + er.reason}`);
  }
}
