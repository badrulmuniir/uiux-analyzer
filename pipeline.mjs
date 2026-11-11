import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { runAnalyzer, evaluate } from './evaluate.mjs';
import { improve } from './improver.mjs';
import { validate } from './validator.mjs';

const replace = (_, b) => b;

const State = Annotation.Root({
  dir: Annotation({ reducer: replace, default: () => 'sample/' }),
  entry: Annotation({ reducer: replace, default: () => 'index.html' }),
  issues: Annotation({ reducer: replace, default: () => [] }),
  scoreBefore: Annotation({ reducer: replace, default: () => 0 }),
  edits: Annotation({ reducer: replace, default: () => [] }),
  scoreAfter: Annotation({ reducer: replace, default: () => null }),
  accepted: Annotation({ reducer: replace, default: () => false }),
  feedback: Annotation({ reducer: replace, default: () => '' }),
  attempts: Annotation({ reducer: replace, default: () => 0 }),
});

const MAX_ATTEMPTS = 3;

async function analyzerNode(state) {
  return { issues: runAnalyzer(path.join(state.dir, state.entry)) };
}

async function evaluatorNode(state) {
  const { score, issues } = evaluate(state.issues);
  const update = { issues, scoreBefore: score };
  if (issues.length === 0) update.accepted = true; // nothing to fix
  return update;
}

function listFiles(root) {
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, d.name);
    if (d.isDirectory()) out.push(...listFiles(p));
    else if (/\.(html?|css|js)$/i.test(d.name)) out.push(p);
  }
  return out;
}

async function improverNode(state) {
  const root = path.resolve(state.dir);
  const files = {};
  for (const f of listFiles(root)) {
    files[path.relative(root, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
  }
  const { edits } = await improve(state.issues.slice(0, 5), files, state.feedback);
  return { edits, attempts: state.attempts + 1 };
}

async function validatorNode(state) {
  const r = validate(state.edits, state.dir, state.entry);
  return { accepted: r.accepted, scoreAfter: r.scoreAfter, feedback: r.reason };
}

const graph = new StateGraph(State)
  .addNode('analyzerNode', analyzerNode)
  .addNode('evaluatorNode', evaluatorNode)
  .addNode('improverNode', improverNode)
  .addNode('validatorNode', validatorNode)
  .addEdge(START, 'analyzerNode')
  .addEdge('analyzerNode', 'evaluatorNode')
  .addConditionalEdges('evaluatorNode', (s) =>
    s.issues.length > 0 && !s.accepted ? 'improverNode' : END
  )
  .addEdge('improverNode', 'validatorNode')
  .addConditionalEdges('validatorNode', (s) =>
    !s.accepted && s.attempts < MAX_ATTEMPTS ? 'improverNode' : END
  );

export const pipeline = graph.compile();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await pipeline.invoke({ dir: 'sample/', entry: 'index.html' });
  console.log(`scoreBefore: ${s.scoreBefore}`);
  console.log(`scoreAfter: ${s.scoreAfter}`);
  console.log(`accepted: ${s.accepted}`);
  console.log(`attempts: ${s.attempts}`);
  console.log(`issues found: ${s.issues.length}`);
}
