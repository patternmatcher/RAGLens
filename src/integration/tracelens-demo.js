import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { RaglensStore } from '../services/store.js';

const QUESTION = 'What caused the May 2026 unsupported delivery estimates?';
const STALE_DOCUMENT = {
  title: 'Legacy Incident Summary',
  sourceType: 'markdown',
  text: `# Legacy Incident Summary

The May 2026 unsupported delivery estimates were caused by a temporary courier outage. This legacy summary is stale and should not be used for current incident review. The root cause was not a policy migration.`
};

export async function buildTraceLensDemoScenario(options = {}) {
  const dataDir = options.dataDir || await mkdtemp(path.join(os.tmpdir(), 'raglens-tracelens-demo-'));
  const store = new RaglensStore(loadConfig({
    RAGLENS_DATA_DIR: dataDir,
    RAGLENS_AUTO_SEED: 'true',
    RAGLENS_OTEL_INCLUDE_CONTENT: 'true',
    RAGLENS_OTEL_SERVICE_NAME: 'raglens-stack-demo'
  }));
  await store.resetDemo();

  const baseline = await store.runQuery({
    question: QUESTION,
    topK: 4,
    maxClaims: 3,
    rerank: true,
    promptLoggingEnabled: true
  });
  await store.addDocument(STALE_DOCUMENT);
  const candidate = await store.runQuery({
    question: QUESTION,
    topK: 1,
    maxClaims: 3,
    rerank: false,
    promptLoggingEnabled: true
  });

  return {
    question: QUESTION,
    corpus: {
      documents: store.state.documents.length,
      chunks: store.state.chunks.length,
      injectedCandidateDocument: STALE_DOCUMENT.title
    },
    baseline: scenarioRun(store, baseline),
    candidate: scenarioRun(store, candidate)
  };
}
function scenarioRun(store, run) {
  const hydrated = store.hydrateRun(run.id, { projectId: run.projectId });
  return {
    runId: run.id,
    topSource: hydrated.retrieved[0]?.document?.title || hydrated.retrieved[0]?.chunk?.documentTitle || '',
    metrics: run.evaluation.metrics,
    answer: run.answer.text,
    otlp: store.exportOtelRun(run.id, { projectId: run.projectId }),
    ragTrace: store.exportRagTrace(run.id, { projectId: run.projectId, includeContent: true })
  };
}
