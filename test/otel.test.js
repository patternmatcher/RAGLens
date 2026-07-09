import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOtlpPayload, exportOtlpTrace, safeEndpointHost } from '../src/observability/otel.js';

const sampleRun = {
  id: 'run_123456abcdef',
  projectId: 'prj_123456abcdef',
  question: 'What happened?',
  createdAt: '2026-06-23T12:00:00.000Z',
  config: {
    model: 'local-extractive-v1',
    provider: 'local',
    retrievalMode: 'hybrid',
    mode: 'local-grounded-extractive'
  },
  query: {
    rewritten: 'what happened',
    expansions: []
  },
  retrieved: [
    {
      chunkId: 'chk_123456abcdef',
      rank: 1,
      score: 0.91,
      rawScore: 0.82,
      rerankScore: 0.94,
      chunk: {
        id: 'chk_123456abcdef',
        text: 'The incident was caused by a stale policy document.',
        documentTitle: 'Incident review',
        section: 'Root cause'
      },
      document: {
        title: 'Incident review',
        checksum: 'abc123'
      }
    }
  ],
  prompt: { text: 'Answer from the incident review.' },
  answer: { text: 'A stale policy document caused the incident.' },
  evaluation: {
    claims: [
      {
        index: 0,
        text: 'A stale policy document caused the incident.',
        status: 'supported',
        confidence: 0.93,
        citations: ['chk_123456abcdef']
      }
    ],
    metrics: {
      faithfulness: 0.93,
      citationCoverage: 1,
      recallAtK: 1,
      contextRelevance: 0.88,
      retrievalConfidence: 0.91,
      precisionAtK: 1,
      mrr: 1,
      answerFocus: 0.72
    }
  },
  warnings: [],
  usage: {
    inputTokens: 40,
    outputTokens: 10,
    totalTokens: 50,
    estimatedCostUsd: 0
  },
  trace: [
    {
      key: 'rewrite-query',
      label: 'Rewrite query',
      detail: 'No expansion required.',
      durationMs: 1
    },
    {
      key: 'retrieve',
      label: 'Retrieve context',
      detail: '1 chunk returned.',
      durationMs: 3
    },
    {
      key: 'build-prompt',
      label: 'Build prompt',
      detail: '40 tokens.',
      durationMs: 1
    },
    {
      key: 'generate',
      label: 'Generate grounded answer',
      detail: '1 citation.',
      durationMs: 4
    },
    {
      key: 'evaluate',
      label: 'Evaluate grounding',
      detail: '1 claim.',
      durationMs: 1
    }
  ]
};

test('buildOtlpPayload creates OTLP resource spans from a run trace', () => {
  const payload = buildOtlpPayload(sampleRun, { serviceName: 'raglens-test' });
  const span = payload.resourceSpans[0].scopeSpans[0].spans.find(
    (item) => attribute(item, 'tracelens.step.type') === 'retrieval'
  );

  assert.equal(payload.resourceSpans[0].resource.attributes[0].value.stringValue, 'raglens-test');
  assert.equal(span.name, 'Retrieve context');
  assert.equal(span.traceId.length, 32);
  assert.equal(span.spanId.length, 16);
  assert.equal(span.attributes.some((item) => item.key === 'raglens.question'), false);
  assert.equal(span.attributes.some((item) => item.key === 'raglens.question_hash'), true);
  assert.equal(span.attributes.some((item) => item.key === 'raglens.question_length'), true);
});

test('buildOtlpPayload can include raw question content only by explicit opt-in', () => {
  const payload = buildOtlpPayload(sampleRun, {
    serviceName: 'raglens-test',
    includeContent: true
  });
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];

  assert.equal(span.attributes.some((item) => item.key === 'raglens.question'), true);
});

test('buildOtlpPayload exports TraceLens evidence, claims, evaluations, usage, and model attributes', () => {
  const payload = buildOtlpPayload(sampleRun, { includeContent: true });
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const retrieval = spans.find((span) => attribute(span, 'tracelens.step.type') === 'retrieval');
  const llm = spans.find((span) => attribute(span, 'tracelens.step.type') === 'llm');
  const evaluation = spans.find((span) => attribute(span, 'tracelens.step.type') === 'evaluation');

  assert.equal(JSON.parse(attribute(retrieval, 'retrieval.documents'))[0].id, 'chk_123456abcdef');
  assert.equal(attribute(llm, 'output.value'), sampleRun.answer.text);
  assert.equal(JSON.parse(attribute(llm, 'tracelens.answer.claims'))[0].status, 'supported');
  assert.equal(attribute(llm, 'gen_ai.usage.total_tokens'), 50);
  assert.equal(attribute(llm, 'gen_ai.request.model'), sampleRun.config.model);
  assert.equal(JSON.parse(attribute(evaluation, 'tracelens.evaluations')).groundedness, 0.93);
});

test('buildOtlpPayload omits private content while preserving evidence structure by default', () => {
  const payload = buildOtlpPayload(sampleRun);
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const retrieval = spans.find((span) => attribute(span, 'tracelens.step.type') === 'retrieval');
  const llm = spans.find((span) => attribute(span, 'tracelens.step.type') === 'llm');
  const documents = JSON.parse(attribute(retrieval, 'retrieval.documents'));

  assert.equal(documents[0].content, '[content omitted by exporter]');
  assert.equal(llm.attributes.some((item) => item.key === 'output.value'), false);
  assert.equal(JSON.stringify(payload).includes(sampleRun.answer.text), false);
  assert.equal(JSON.stringify(payload).includes(sampleRun.prompt.text), false);
});

test('exportOtlpTrace posts to the configured collector without exposing headers in status', async () => {
  let postedHeaders = {};
  let postedPayload = null;
  const result = await exportOtlpTrace(sampleRun, {
    endpoint: 'https://otel.example.test/v1/traces',
    serviceName: 'raglens-test',
    timeoutMs: 5_000,
    headers: {
      Authorization: 'Bearer secret'
    },
    fetchImpl: async (_url, options) => {
      postedHeaders = options.headers;
      postedPayload = JSON.parse(options.body);
      return new Response('', { status: 202 });
    }
  });

  assert.equal(postedHeaders.Authorization, 'Bearer secret');
  assert.equal(postedPayload.resourceSpans.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.endpointHost, 'otel.example.test');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('exportOtlpTrace records collector failures without throwing', async () => {
  const result = await exportOtlpTrace(sampleRun, {
    endpoint: 'https://otel.example.test/v1/traces',
    fetchImpl: async () => new Response('nope', { status: 500 })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /HTTP 500/);
});

test('safeEndpointHost strips paths, queries, and credentials', () => {
  assert.equal(safeEndpointHost('https://user:pass@otel.example.test/v1/traces?token=secret'), 'otel.example.test');
});

function attribute(span, key) {
  const value = span.attributes.find((item) => item.key === key)?.value || {};
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue;
}
