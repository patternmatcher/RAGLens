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
  trace: [
    {
      key: 'retrieve',
      label: 'Retrieve context',
      detail: '1 chunk returned.',
      durationMs: 3
    }
  ]
};

test('buildOtlpPayload creates OTLP resource spans from a run trace', () => {
  const payload = buildOtlpPayload(sampleRun, { serviceName: 'raglens-test' });
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];

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
