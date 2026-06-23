import { createHash } from 'node:crypto';

const OTLP_CONTENT_TYPE = 'application/json';

export function buildRaglensTrace(run, options = {}) {
  return {
    resource: {
      serviceName: options.serviceName || 'raglens',
      serviceVersion: '1.0.0'
    },
    traceId: run.id,
    projectId: run.projectId || null,
    spans: run.trace.map((step, index) => ({
      spanId: `${run.id}:${index + 1}`,
      name: step.label,
      attributes: {
        key: step.key,
        detail: step.detail,
        ...questionTraceAttributes(run, options),
        model: run.config.model,
        provider: run.config.provider,
        retrievalMode: run.config.retrievalMode,
        mode: run.config.mode
      },
      durationMs: step.durationMs
    }))
  };
}

export function buildOtlpPayload(run, options = {}) {
  const startNs = BigInt(Date.parse(run.createdAt || new Date().toISOString())) * 1_000_000n;
  let offsetNs = 0n;

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute('service.name', options.serviceName || 'raglens'),
            stringAttribute('service.version', '1.0.0'),
            stringAttribute('raglens.run_id', run.id),
            stringAttribute('raglens.project_id', run.projectId || 'unknown')
          ]
        },
        scopeSpans: [
          {
            scope: {
              name: 'raglens.pipeline',
              version: '1.0.0'
            },
            spans: run.trace.map((step, index) => {
              const durationNs = BigInt(Math.max(1, Number(step.durationMs || 0))) * 1_000_000n;
              const spanStart = startNs + offsetNs;
              const spanEnd = spanStart + durationNs;
              offsetNs += durationNs;

              return {
                traceId: traceId(run.id),
                spanId: spanId(run.id, index),
                name: step.label,
                kind: 1,
                startTimeUnixNano: spanStart.toString(),
                endTimeUnixNano: spanEnd.toString(),
                attributes: [
                  stringAttribute('raglens.step_key', step.key),
                  stringAttribute('raglens.step_detail', step.detail),
                  ...questionOtlpAttributes(run, options),
                  stringAttribute('raglens.model', run.config.model),
                  stringAttribute('raglens.provider', run.config.provider),
                  stringAttribute('raglens.retrieval_mode', run.config.retrievalMode),
                  stringAttribute('raglens.mode', run.config.mode),
                  doubleAttribute('raglens.duration_ms', Number(step.durationMs || 0))
                ]
              };
            })
          }
        ]
      }
    ]
  };
}

export async function exportOtlpTrace(run, config = {}) {
  if (!config.endpoint) {
    return {
      configured: false,
      attempted: false,
      ok: false,
      status: null,
      endpointHost: '',
      exportedAt: null,
      error: null
    };
  }

  const fetchImpl = config.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return exportFailure(config, 'Fetch is unavailable in this runtime.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.timeoutMs || 5_000));

  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        ...config.headers,
        'Content-Type': OTLP_CONTENT_TYPE
      },
      body: JSON.stringify(buildOtlpPayload(run, config)),
      signal: controller.signal
    });

    return {
      configured: true,
      attempted: true,
      ok: response.ok,
      status: response.status,
      endpointHost: safeEndpointHost(config.endpoint),
      exportedAt: new Date().toISOString(),
      error: response.ok ? null : `OTLP collector returned HTTP ${response.status}.`
    };
  } catch (error) {
    return exportFailure(config, error.name === 'AbortError'
      ? `OTLP export timed out after ${config.timeoutMs || 5_000}ms.`
      : error.message);
  } finally {
    clearTimeout(timeout);
  }
}

export function safeEndpointHost(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.host;
  } catch {
    return '';
  }
}

function exportFailure(config, message) {
  return {
    configured: true,
    attempted: true,
    ok: false,
    status: null,
    endpointHost: safeEndpointHost(config.endpoint),
    exportedAt: new Date().toISOString(),
    error: message || 'OTLP export failed.'
  };
}

function traceId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function spanId(value, index) {
  return createHash('sha256').update(`${value}:${index}`).digest('hex').slice(0, 16);
}

function questionTraceAttributes(run, options = {}) {
  if (options.includeContent === true) {
    return {
      question: run.question
    };
  }
  return {
    questionHash: contentHash(run.question),
    questionLength: String(run.question || '').length
  };
}

function questionOtlpAttributes(run, options = {}) {
  if (options.includeContent === true) {
    return [stringAttribute('raglens.question', run.question)];
  }
  return [
    stringAttribute('raglens.question_hash', contentHash(run.question)),
    doubleAttribute('raglens.question_length', String(run.question || '').length)
  ];
}

function contentHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function stringAttribute(key, value) {
  return {
    key,
    value: {
      stringValue: String(value || '')
    }
  };
}

function doubleAttribute(key, value) {
  return {
    key,
    value: {
      doubleValue: Number(value || 0)
    }
  };
}
