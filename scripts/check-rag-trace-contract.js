import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { RaglensStore } from '../src/services/store.js';
import { buildRagTraceV2, validateRagTraceV2 } from '../src/observability/rag-trace-v2.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-trace-contract-'));
const store = new RaglensStore(loadConfig({
  RAGLENS_HOST: '127.0.0.1',
  RAGLENS_PORT: '0',
  RAGLENS_DATA_DIR: dataDir,
  RAGLENS_AUTO_SEED: 'true'
}));
await store.resetDemo();
const state = store.state;
const projectId = state.activeProjectId;
const run = await store.runQuery({
  question: state.evalQuestions[0].question,
  projectId
});
const hydrated = store.hydrateRun(run.id, { projectId });
const trace = buildRagTraceV2(hydrated, { includeContent: true });
const validation = validateRagTraceV2(trace);

assert.equal(validation.ok, true, validation.errors.join('\n'));
assert.equal(trace.schemaVersion, 'tracelens.rag-trace/v2');
assert.ok(trace.retrieval.stages.some((stage) => stage.kind === 'fusion'));
assert.ok(trace.retrieval.stages.some((stage) => stage.kind === 'rerank'));
assert.ok(trace.evidence.length > 0);
assert.ok(trace.answer.claims.length > 0);
assert.ok(trace.evidence.every((item) => item.provenance));
assert.equal(typeof trace.evaluations.hitRateAtK, 'number');
assert.equal(typeof trace.evaluations.ndcgAtK, 'number');
assert.ok(trace.usage.embeddingCache);

const siblingImporter = path.resolve('..', 'tracelens', 'src', 'shared', 'rag-trace.js');
try {
  const { importRagTrace, validateRagTrace } = await import(pathToFileURL(siblingImporter));
  assert.equal(validateRagTrace(trace).ok, true);
  const imported = importRagTrace(trace);
  assert.equal(imported.app.traceSource, 'tracelens.rag-trace/v2');
  assert.equal(imported.evidence.length, trace.evidence.length);
  assert.ok(imported.steps.some((step) => step.metadata?.kind === 'context'));
  assert.equal(imported.evaluations.hitRateAtK, trace.evaluations.hitRateAtK);
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

console.log('RAG trace v2 contract check passed.');
