import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRagTraceV2, validateRagTraceV2 } from '../src/observability/rag-trace-v2.js';

test('exports a versioned staged RAG trace without content by default', () => {
  const trace = buildRagTraceV2(exampleRun());

  assert.equal(validateRagTraceV2(trace).ok, true);
  assert.equal(trace.schemaVersion, 'tracelens.rag-trace/v2');
  assert.equal(trace.query.original, '[query content omitted by exporter]');
  assert.deepEqual(trace.query.expansions, []);
  assert.deepEqual(trace.query.decomposed, []);
  assert.deepEqual(trace.corpus.expectedSources, []);
  assert.deepEqual(trace.retrieval.filter, {});
  assert.equal(trace.evidence[0].text, '[content omitted by exporter]');
  assert.equal(trace.evidence[0].documentTitle, '[metadata omitted by exporter]');
  assert.equal(trace.evidence[0].provenance.section, '');
  assert.equal(trace.evidence[0].provenance.sourceUri, '');
  assert.equal(trace.warnings[0].message, 'Warning details omitted by exporter.');
  assert.deepEqual(trace.retrieval.stages.map((stage) => stage.kind), ['fusion', 'rerank', 'context']);
  assert.equal(trace.evidence[0].provenance.pageStart, 3);
  assert.equal(trace.evaluations.mrr, 1);
  assert.equal(trace.evaluations.hitRateAtK, 1);
  assert.equal(trace.usage.embeddingCache.hits, 1);
});

test('can include content for trusted local interoperability', () => {
  const trace = buildRagTraceV2(exampleRun(), { includeContent: true });

  assert.equal(trace.query.original, 'What changed?');
  assert.equal(trace.evidence[0].text, 'Refunds are available for 30 days.');
  assert.equal(trace.answer.claims[0].text, 'Refunds are available for 30 days.');
  assert.equal(trace.privacy.safeToExport, false);
});

function exampleRun() {
  return {
    id: 'run_contract',
    projectId: 'project_contract',
    question: 'What changed?',
    createdAt: '2026-08-03T10:00:00.000Z',
    latencyMs: 20,
    config: {
      retrievalMode: 'hybrid',
      rerank: true,
      topK: 5,
      indexedChunks: 10,
      chunkTokens: 500,
      overlapTokens: 50,
      provider: 'local',
      model: 'local-extractive-v1',
      mode: 'local-extractive',
      metadataFilter: { collection: 'confidential-policy' }
    },
    query: { rewritten: 'refund change', expansions: ['refund'], subqueries: ['refund duration'] },
    retrieved: [{
      chunkId: 'chunk_1',
      rank: 1,
      score: 0.9,
      rawScore: 3.4,
      lexicalScore: 2.8,
      similarityScore: 0.8,
      rerankScore: 4.2,
      coverage: 1,
      novelty: 1,
      document: {
        id: 'doc_1',
        title: 'Refund policy',
        checksum: 'abc',
        sourceType: 'pdf',
        metadata: { sourceUri: 'https://internal.example.test/refund-policy' }
      },
      chunk: {
        id: 'chunk_1',
        documentId: 'doc_1',
        documentTitle: 'Refund policy',
        section: 'Refund window',
        page: 3,
        tokenCount: 8,
        embeddingModel: 'local-hash-embedding-v1',
        text: 'Refunds are available for 30 days.'
      }
    }],
    answer: { text: 'Refunds are available for 30 days.' },
    evaluation: {
      claims: [{ index: 0, text: 'Refunds are available for 30 days.', status: 'supported', citations: ['chunk_1'], confidence: 0.9 }],
      metrics: { faithfulness: 1, citationCoverage: 1, recallAtK: 1, precisionAtK: 1, hitRateAtK: 1, mrr: 1 }
    },
    warnings: [{ severity: 'high', type: 'expected-answer-mismatch', message: 'Missing secret evaluation terms.' }],
    trace: [{ key: 'rewrite-query', durationMs: 1 }],
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, embeddingCache: { hits: 1, misses: 0, hitRate: 1 }, retrievalMs: 4, generationMs: 10, evaluationMs: 2 }
  };
}
