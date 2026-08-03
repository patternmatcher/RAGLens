import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';

test('chunkDocument keeps document metadata and creates searchable chunks', () => {
  const document = createDocument({
    title: 'Policy',
    sourceType: 'markdown',
    text: `# Delivery Policy

Enterprise delivery estimates must be cited from the current logistics policy.

## Review

Unsupported estimates route to manual review.`
  });

  const chunks = chunkDocument(document, {
    maxTokens: 40,
    overlapTokens: 6
  });

  assert.equal(document.title, 'Policy');
  assert.equal(document.status, 'indexed');
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].documentId, document.id);
  assert.ok(chunks[0].terms.includes('delivery'));
  assert.match(chunks[0].stableChunkId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(chunks[0].page, null);
  assert.equal(chunks[0].pageNumbersExact, false);
});

test('chunkDocument preserves exact source pages and stable chunk identities', () => {
  const firstPage = 'Page one contains the current delivery policy text.';
  const secondPage = 'Page two says the refund window is 30 days.';
  const text = `${firstPage}\n\n${secondPage}`;
  const document = createDocument({
    title: 'Paged policy',
    sourceType: 'pdf',
    text,
    metadata: {
      pageSpans: [
        { pageNumber: 1, exact: true, characterStart: 0, characterEnd: firstPage.length },
        { pageNumber: 2, exact: true, characterStart: firstPage.length + 2, characterEnd: text.length }
      ]
    }
  });

  const first = chunkDocument(document, { maxTokens: 40, overlapTokens: 6 });
  const second = chunkDocument(document, { maxTokens: 40, overlapTokens: 6 });

  assert.deepEqual(first.map((chunk) => chunk.page), [1, 2]);
  assert.ok(first.every((chunk) => chunk.pageStart === chunk.pageEnd));
  assert.ok(first.every((chunk) => chunk.pageNumbersExact));
  assert.deepEqual(first.map((chunk) => chunk.stableChunkId), second.map((chunk) => chunk.stableChunkId));
  assert.equal(first[1].characterStart, firstPage.length + 2);
  assert.equal(first[1].characterEnd, text.length);
});
