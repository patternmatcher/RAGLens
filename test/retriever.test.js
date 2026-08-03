import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { applyMetadataFilter, retrieve } from '../src/rag/retriever.js';

test('retrieve ranks the relevant chunk first for a policy query', () => {
  const documents = [
    createDocument({
      title: 'Delivery Policy',
      text: 'Current delivery estimates require a citation. Unsupported delivery estimates go to manual review.'
    }),
    createDocument({
      title: 'Billing Policy',
      text: 'Invoices are generated monthly. Payment terms are net thirty days for approved customers.'
    })
  ];
  const chunks = documents.flatMap((document) => chunkDocument(document));

  const result = retrieve('What happens to unsupported delivery estimates?', chunks, { topK: 2 });

  assert.equal(result.results[0].chunk.documentTitle, 'Delivery Policy');
  assert.ok(result.results[0].score > 0.3);
  assert.ok(result.results[0].matchedTerms.includes('delivery'));
  assert.deepEqual(result.stages.map((stage) => stage.kind), ['sparse', 'dense', 'fusion', 'rerank', 'context']);
  assert.ok(result.stats.candidateDepth >= result.results.length);
});

test('metadata filters scope retrieval before candidate ranking', () => {
  const current = chunkDocument(createDocument({
    title: 'Current finance policy',
    sourceType: 'markdown',
    text: 'The current finance refund period is thirty days for approved purchases.',
    metadata: { collection: 'policies', department: 'finance', version: 'v3', tags: ['current'] }
  }), { maxTokens: 40, overlapTokens: 0 })[0];
  const stale = chunkDocument(createDocument({
    title: 'Old support policy',
    sourceType: 'markdown',
    text: 'The old support refund period is fourteen days for approved purchases.',
    metadata: { collection: 'archive', department: 'support', version: 'v1', tags: ['stale'] }
  }), { maxTokens: 40, overlapTokens: 0 })[0];

  const filter = { collections: ['policies'], departments: ['finance'], tags: ['current'] };
  assert.deepEqual(applyMetadataFilter([current, stale], filter).map((chunk) => chunk.id), [current.id]);

  const result = retrieve('What is the refund period?', [current, stale], {
    topK: 5,
    metadataFilter: filter
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].chunk.id, current.id);
  assert.equal(result.stats.filteredOut, 1);
});
