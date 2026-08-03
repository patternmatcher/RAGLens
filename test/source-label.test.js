import assert from 'node:assert/strict';
import test from 'node:test';
import { labelMapForRetrieved, sourceLabelForChunk } from '../src/rag/source-label.js';

test('source labels stay unique for chunks with colliding document prefixes', () => {
  const retrieved = [
    {
      chunk: {
        id: 'chk_first111111',
        documentId: 'doc_abcd11111111',
        index: 0
      }
    },
    {
      chunk: {
        id: 'chk_second222222',
        documentId: 'doc_abcd22222222',
        index: 0
      }
    }
  ];
  const labels = retrieved.map((item) => sourceLabelForChunk(item.chunk));
  const labelMap = labelMapForRetrieved(retrieved);

  assert.notEqual(labels[0], labels[1]);
  assert.equal(labelMap.size, 2);
  assert.equal(labelMap.get(labels[0]), 'chk_first111111');
  assert.equal(labelMap.get(labels[1]), 'chk_second222222');
});

test('source labels include verified PDF page ranges', () => {
  const label = sourceLabelForChunk({
    id: 'chk_page',
    documentId: 'doc_policy',
    index: 2,
    pageStart: 4,
    pageEnd: 5,
    pageNumbersExact: true
  });

  assert.match(label, /:P4-5:C3$/);
});
