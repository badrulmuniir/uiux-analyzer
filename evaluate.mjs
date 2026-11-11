import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const WEIGHTS = {
  'html-has-lang': 7, 'document-title': 7, 'image-alt': 10, 'label': 7,
  'button-name': 10, 'link-name': 7, 'meta-viewport': 3, 'color-contrast': 7,
  'heading-order': 3, 'page-has-heading-one': 3, 'empty-heading': 1,
  'target-size': 3, 'focus-visible': 7, 'text-spacing': 7,
  'placeholder-only-label': 7, 'line-height': 1, 'duplicate-id': 3,
};

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

export function evaluate(issues) {
  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const fired = new Set(issues.map((i) => i.id));
  const passedWeight = Object.entries(WEIGHTS)
    .filter(([id]) => !fired.has(id))
    .reduce((sum, [, w]) => sum + w, 0);
  const score = Math.round((passedWeight / totalWeight) * 100);
  const sorted = [...issues].sort(
    (a, b) => (IMPACT_ORDER[a.impact] ?? 4) - (IMPACT_ORDER[b.impact] ?? 4)
  );
  return { score, totalWeight, passedWeight, issues: sorted };
}

function runAnalyzer(file) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, [path.join(dir, 'analyze.mjs'), file], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`analyze.mjs failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || path.join('sample', 'index.html');
  const { score, totalWeight, passedWeight, issues } = evaluate(runAnalyzer(file));
  console.log(`Score: ${score}/100`);
  console.log(`Total weight: ${totalWeight}`);
  console.log(`Passed weight: ${passedWeight}`);
  console.log('\nIssues (by impact):');
  for (const i of issues) {
    console.log(`  ${i.id}  impact=${i.impact}  wcag=${i.wcag ?? '-'}  nodes=${i.nodes?.length ?? 0}`);
  }
}
