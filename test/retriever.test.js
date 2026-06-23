import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { retrieve } from '../src/rag/retriever.js';

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
});
