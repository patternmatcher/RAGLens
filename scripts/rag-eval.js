import { loadConfig } from '../src/config.js';
import { RaglensStore } from '../src/services/store.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-eval-'));
const store = new RaglensStore(
  loadConfig({
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: '0',
    RAGLENS_DATA_DIR: dataDir,
    RAGLENS_AUTO_SEED: 'true'
  })
);

await store.resetDemo();

const results = [];
for (const item of store.state.evalQuestions) {
  const run = await store.runQuery({
    question: item.question,
    topK: store.state.settings.topK,
    maxClaims: store.state.settings.maxClaims
  });
  results.push({
    question: item.question,
    expectedSource: item.expectedSource,
    faithfulness: run.evaluation.metrics.faithfulness,
    citationCoverage: run.evaluation.metrics.citationCoverage,
    recallAtK: run.evaluation.metrics.recallAtK,
    mrr: run.evaluation.metrics.mrr,
    expectedAnswerCoverage: run.evaluation.metrics.expectedAnswerCoverage
  });
}

const failed = results.filter(
  (result) =>
    result.faithfulness < 0.55 ||
    result.citationCoverage < 0.7 ||
    result.recallAtK < 1 ||
    result.expectedAnswerCoverage < 0.45
);

console.table(results);

if (failed.length) {
  console.error(`RAG eval failed for ${failed.length} question(s).`);
  process.exit(1);
}

console.log('RAG eval passed.');
