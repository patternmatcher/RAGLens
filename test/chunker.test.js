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
});
