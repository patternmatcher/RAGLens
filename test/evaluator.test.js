import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRun } from '../src/rag/evaluator.js';

test('claim support is based on the cited chunk when a citation exists', () => {
  const retrieved = [
    {
      rank: 1,
      score: 0.9,
      coverage: 1,
      chunk: {
        id: 'chk_good',
        documentTitle: 'Correct',
        terms: ['delivery', 'estimate', 'manual', 'review'],
        text: 'Unsupported delivery estimates go to manual review.'
      }
    },
    {
      rank: 2,
      score: 0.7,
      coverage: 0.5,
      chunk: {
        id: 'chk_bad',
        documentTitle: 'Wrong',
        terms: ['billing', 'invoice'],
        text: 'Invoices are generated monthly.'
      }
    }
  ];

  const evaluation = evaluateRun({
    question: 'What happens to unsupported delivery estimates?',
    answerText: 'Unsupported delivery estimates go to manual review. [DTEST:C1]',
    citations: [{ claimIndex: 0, chunkId: 'chk_bad', label: 'DTEST:C1' }],
    retrieved
  });

  assert.equal(evaluation.claims[0].bestChunkId, 'chk_good');
  assert.equal(evaluation.claims[0].status, 'unsupported');
  assert.equal(evaluation.claims[0].sourceSupport.find((item) => item.chunkId === 'chk_bad').status, 'unsupported');
  assert.equal(evaluation.claims[0].sourceSupport.find((item) => item.chunkId === 'chk_good').status, 'supported');
});

test('claim source support scores each cited chunk independently', () => {
  const retrieved = [
    {
      rank: 1,
      score: 0.9,
      coverage: 1,
      chunk: {
        id: 'chk_good',
        documentTitle: 'Correct',
        terms: ['refund', 'requires', 'manual', 'support', 'review'],
        text: 'Refund escalations require manual support review.'
      }
    },
    {
      rank: 2,
      score: 0.7,
      coverage: 0.5,
      chunk: {
        id: 'chk_bad',
        documentTitle: 'Wrong',
        terms: ['delivery', 'window', 'calendar'],
        text: 'Delivery windows are calculated from calendar days.'
      }
    }
  ];

  const evaluation = evaluateRun({
    question: 'What do refund escalations require?',
    answerText: 'Refund escalations require manual support review. [DTEST:C1] [DTEST:C2]',
    citations: [
      { claimIndex: 0, chunkId: 'chk_good', label: 'DTEST:C1' },
      { claimIndex: 0, chunkId: 'chk_bad', label: 'DTEST:C2' }
    ],
    retrieved
  });
  const claim = evaluation.claims[0];

  assert.equal(claim.status, 'supported');
  assert.equal(claim.sourceSupport.find((item) => item.chunkId === 'chk_good').status, 'supported');
  assert.equal(claim.sourceSupport.find((item) => item.chunkId === 'chk_bad').status, 'unsupported');
  assert.equal(claim.sourceSupport.find((item) => item.chunkId === 'chk_bad').cited, true);
});

test('conflicting source warnings identify the chunks that triggered review', () => {
  const retrieved = [
    {
      rank: 1,
      score: 0.8,
      coverage: 0.7,
      chunk: {
        id: 'chk_current',
        label: 'Current Policy / C1',
        documentTitle: 'Current Policy',
        terms: ['delivery', 'policy', 'current'],
        text: 'The current delivery policy is active in production and requires manual review.'
      }
    },
    {
      rank: 2,
      score: 0.72,
      coverage: 0.7,
      chunk: {
        id: 'chk_stale',
        label: 'Old Policy / C1',
        documentTitle: 'Old Policy',
        terms: ['delivery', 'policy', 'stale'],
        text: 'The previous delivery policy is stale and deprecated after migration.'
      }
    }
  ];

  const evaluation = evaluateRun({
    question: 'What is the delivery policy?',
    answerText: 'The current delivery policy requires manual review. [DTEST:C1]',
    citations: [{ claimIndex: 0, chunkId: 'chk_current', label: 'DTEST:C1' }],
    retrieved
  });
  const warning = evaluation.warnings.find((item) => item.type === 'conflicting-sources');

  assert.ok(warning);
  assert.deepEqual(warning.chunkIds, ['chk_stale', 'chk_current']);
  assert.match(warning.message, /Old Policy \/ C1/);
  assert.match(evaluation.failureSummary, /conflicting-sources/);
});

test('expected answer coverage flags right-source wrong-answer eval failures', () => {
  const retrieved = [
    {
      rank: 1,
      score: 0.9,
      coverage: 1,
      chunk: {
        id: 'chk_expected',
        label: 'Eval Source / C1',
        documentTitle: 'Eval Source',
        terms: ['refund', 'manual', 'review', 'support'],
        text: 'Refund escalations require manual review by support.'
      }
    }
  ];

  const evaluation = evaluateRun({
    question: 'What do refund escalations require?',
    answerText: 'Refund escalations are answered automatically. [DTEST:C1]',
    citations: [{ claimIndex: 0, chunkId: 'chk_expected', label: 'DTEST:C1' }],
    retrieved,
    expectedSource: 'Eval Source',
    expectedAnswer: 'Refund escalations require manual review by support.'
  });

  assert.equal(evaluation.metrics.recallAtK, 1);
  assert.equal(evaluation.metrics.expectedAnswerAvailable, true);
  assert.equal(evaluation.metrics.expectedAnswerCoverage < 0.45, true);
  assert.ok(evaluation.expectedAnswer.missingTerms.includes('manual'));
  assert.ok(evaluation.warnings.some((warning) => warning.type === 'expected-answer-mismatch'));
});

test('ground-truth metrics support multiple acceptable source documents', () => {
  const retrieved = [
    {
      rank: 1,
      score: 0.9,
      coverage: 1,
      chunk: {
        id: 'chk_policy',
        documentTitle: 'Policy v3',
        terms: ['refund', 'thirty', 'days'],
        text: 'The refund period is thirty days.'
      }
    },
    {
      rank: 2,
      score: 0.7,
      coverage: 0.5,
      chunk: {
        id: 'chk_faq',
        documentTitle: 'Support FAQ',
        terms: ['support', 'contact'],
        text: 'Contact support for help.'
      }
    }
  ];
  const evaluation = evaluateRun({
    question: 'What changed in the refund policy?',
    answerText: 'The refund period is thirty days. [DTEST:C1]',
    citations: [{ claimIndex: 0, chunkId: 'chk_policy', label: 'DTEST:C1' }],
    retrieved,
    expectedSources: ['Policy v3', 'Policy changelog']
  });

  assert.equal(evaluation.metrics.evalAvailable, true);
  assert.equal(evaluation.metrics.expectedSourceCount, 2);
  assert.equal(evaluation.metrics.expectedSourceHits, 1);
  assert.equal(evaluation.metrics.recallAtK, 1);
  assert.equal(evaluation.metrics.sourceRecallAtK, 0.5);
  assert.equal(evaluation.metrics.allSourceRecallAtK, 0);
  assert.equal(evaluation.metrics.mrr, 1);
});

test('trailing citation labels do not become empty unsupported claims', () => {
  const retrieved = [
    {
      rank: 1,
      score: 0.9,
      coverage: 1,
      chunk: {
        id: 'chk_policy',
        documentTitle: 'Policy',
        terms: ['refund', 'window', 'thirty', 'days'],
        text: 'The refund window is thirty days.'
      }
    }
  ];
  const evaluation = evaluateRun({
    question: 'What is the refund window?',
    answerText: 'The refund window is thirty days. [DTEST:C1]',
    citations: [{ claimIndex: 0, chunkId: 'chk_policy', label: 'DTEST:C1' }],
    retrieved
  });

  assert.equal(evaluation.claims.length, 1);
  assert.equal(evaluation.claims[0].status, 'supported');
  assert.equal(evaluation.metrics.citationCoverage, 1);
  assert.equal(evaluation.warnings.some((warning) => warning.type === 'unsupported-claim'), false);
});
