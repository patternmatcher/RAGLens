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
  const includeContent = options.includeContent === true;
  const serviceName = options.serviceName || 'raglens';

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute('service.name', serviceName),
            stringAttribute('service.version', '1.0.0'),
            stringAttribute('service.namespace', 'raglens'),
            stringAttribute('deployment.environment.name', options.environment || 'local'),
            stringAttribute('raglens.run_id', run.id),
            stringAttribute('raglens.project_id', run.projectId || 'unknown'),
            stringAttribute('tracelens.privacy.redaction_profile', includeContent ? 'not-redacted' : 'content-omitted'),
            boolAttribute('tracelens.privacy.contains_private_data', includeContent),
            boolAttribute('tracelens.privacy.safe_to_export', !includeContent)
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
              const descriptor = describeStep(step, run, { includeContent });

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
                  stringAttribute('tracelens.step.type', descriptor.type),
                  stringAttribute('openinference.span.kind', descriptor.openInferenceKind),
                  stringAttribute('gen_ai.operation.name', descriptor.operation),
                  ...questionOtlpAttributes(run, { includeContent }),
                  stringAttribute('raglens.model', run.config?.model),
                  stringAttribute('raglens.provider', run.config?.provider),
                  stringAttribute('raglens.retrieval_mode', run.config.retrievalMode),
                  stringAttribute('raglens.mode', run.config.mode),
                  stringAttribute('gen_ai.system', run.config?.provider || 'local'),
                  stringAttribute('gen_ai.request.model', run.config?.model || 'local-extractive-v1'),
                  doubleAttribute('raglens.duration_ms', Number(step.durationMs || 0)),
                  ...descriptor.attributes
                ]
              };
            })
          }
        ]
      }
    ]
  };
}

function describeStep(step, run, options) {
  const type = stepType(step?.key);
  const descriptor = {
    type,
    openInferenceKind: openInferenceKind(type),
    operation: operationName(type),
    attributes: []
  };
  const includeContent = options.includeContent === true;

  if (type === 'query_rewrite') {
    addContentAttribute(descriptor.attributes, 'input.value', run.question, includeContent);
    addContentAttribute(descriptor.attributes, 'output.value', run.query?.rewritten, includeContent);
    descriptor.attributes.push(jsonAttribute('raglens.query.expansions', run.query?.expansions || []));
  }

  if (type === 'retrieval') {
    descriptor.attributes.push(
      jsonAttribute('retrieval.documents', retrievalDocuments(run, includeContent)),
      doubleAttribute('raglens.retrieval.top_k', Number(run.config?.topK || 0)),
      stringAttribute('raglens.retrieval.mode', run.config?.retrievalMode || ''),
      boolAttribute('raglens.retrieval.rerank_enabled', run.config?.rerank !== false)
    );
    addContentAttribute(descriptor.attributes, 'input.value', run.query?.rewritten || run.question, includeContent);
  }

  if (type === 'guardrail') {
    descriptor.attributes.push(jsonAttribute('tracelens.failure_notes', failureNotes(run.warnings)));
  }

  if (type === 'prompt') {
    descriptor.attributes.push(
      jsonAttribute('llm.prompt_context.document_ids', evidenceIds(run)),
      doubleAttribute('raglens.prompt.estimated_tokens', Number(run.usage?.inputTokens || 0)),
      stringAttribute('raglens.prompt.template_fingerprint', run.config?.promptTemplateFingerprint || '')
    );
    addContentAttribute(descriptor.attributes, 'input.value', run.prompt?.text, includeContent);
  }

  if (type === 'llm') {
    descriptor.attributes.push(
      doubleAttribute('gen_ai.usage.input_tokens', Number(run.usage?.inputTokens || 0)),
      doubleAttribute('gen_ai.usage.output_tokens', Number(run.usage?.outputTokens || 0)),
      doubleAttribute('gen_ai.usage.total_tokens', Number(run.usage?.totalTokens || 0)),
      doubleAttribute('raglens.estimated_cost_usd', Number(run.usage?.estimatedCostUsd || 0)),
      jsonAttribute('tracelens.answer.claims', exportedClaims(run, includeContent)),
      jsonAttribute('llm.prompt_context.document_ids', evidenceIds(run))
    );
    addContentAttribute(descriptor.attributes, 'output.value', run.answer?.text, includeContent);
  }

  if (type === 'evaluation') {
    descriptor.attributes.push(
      jsonAttribute('tracelens.evaluations', exportedEvaluations(run)),
      jsonAttribute('tracelens.answer.claims', exportedClaims(run, includeContent)),
      jsonAttribute('tracelens.failure_notes', failureNotes(run.warnings))
    );
  }

  return descriptor;
}

function stepType(key) {
  const normalized = String(key || '').toLowerCase();
  if (normalized.includes('rewrite')) return 'query_rewrite';
  if (normalized.includes('retrieve') || normalized.includes('search')) return 'retrieval';
  if (normalized.includes('rerank')) return 'rerank';
  if (normalized.includes('risk') || normalized.includes('guard')) return 'guardrail';
  if (normalized.includes('prompt')) return 'prompt';
  if (normalized.includes('generate') || normalized.includes('llm')) return 'llm';
  if (normalized.includes('eval')) return 'evaluation';
  return 'other';
}

function openInferenceKind(type) {
  return {
    query_rewrite: 'CHAIN',
    retrieval: 'RETRIEVER',
    rerank: 'RERANKER',
    guardrail: 'GUARDRAIL',
    prompt: 'PROMPT',
    llm: 'LLM',
    evaluation: 'EVALUATOR'
  }[type] || 'CHAIN';
}

function operationName(type) {
  return {
    query_rewrite: 'query_rewrite',
    retrieval: 'retrieval',
    rerank: 'rerank',
    guardrail: 'guardrail',
    prompt: 'prompt',
    llm: 'chat',
    evaluation: 'evaluation'
  }[type] || 'other';
}

function retrievalDocuments(run, includeContent) {
  return (run.retrieved || []).map((item) => ({
    id: item.chunkId,
    content: includeContent ? item.chunk?.text || '' : '[content omitted by exporter]',
    score: Number(item.score || 0),
    metadata: {
      name: item.document?.title || item.chunk?.documentTitle || item.chunkId,
      chunk_id: item.chunkId,
      section: item.chunk?.section || item.chunk?.heading || '',
      page: item.chunk?.page || null,
      checksum: item.document?.checksum || '',
      sensitivity: 'internal',
      rank: Number(item.rank || 0),
      raw_score: Number(item.rawScore || 0),
      rerank_score: Number(item.rerankScore || 0)
    }
  }));
}

function exportedClaims(run, includeContent) {
  return (run.evaluation?.claims || []).map((claim, index) => ({
    id: `claim_${Number(claim.index ?? index) + 1}`,
    text: includeContent ? claim.text || '' : '[claim content omitted by exporter]',
    status: normalizeClaimStatus(claim.status),
    evidenceIds: claim.citations?.length
      ? claim.citations
      : [claim.bestChunkId].filter(Boolean),
    confidence: Number(claim.confidence || 0),
    unsupportedReason: claim.status === 'unsupported' ? 'No retrieved evidence met the support threshold.' : ''
  }));
}

function exportedEvaluations(run) {
  const metrics = run.evaluation?.metrics || {};
  return {
    groundedness: numberMetric(metrics.faithfulness),
    faithfulness: numberMetric(metrics.faithfulness),
    citationCoverage: numberMetric(metrics.citationCoverage),
    retrievalRecall: numberMetric(metrics.recallAtK),
    contextRelevance: numberMetric(metrics.contextRelevance),
    retrievalConfidence: numberMetric(metrics.retrievalConfidence),
    precisionAtK: numberMetric(metrics.precisionAtK),
    mrr: numberMetric(metrics.mrr),
    answerFocus: numberMetric(metrics.answerFocus)
  };
}

function failureNotes(warnings = []) {
  return warnings.map((warning) => ({
    type: warning.type || 'raglens-warning',
    severity: normalizeSeverity(warning.severity),
    message: warning.message || 'RAGLens reported a run warning.',
    stepId: warning.stepId || '',
    evidenceIds: [warning.chunkId].filter(Boolean)
  }));
}

function evidenceIds(run) {
  return (run.retrieved || []).map((item) => item.chunkId).filter(Boolean);
}

function normalizeClaimStatus(status) {
  return ['supported', 'partial', 'unsupported', 'uncited', 'unknown'].includes(status)
    ? status
    : 'unknown';
}

function normalizeSeverity(severity) {
  return ['info', 'low', 'medium', 'high', 'critical'].includes(severity)
    ? severity
    : 'medium';
}

function numberMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function addContentAttribute(attributes, key, value, includeContent) {
  if (includeContent && value) {
    attributes.push(stringAttribute(key, value));
  }
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

function boolAttribute(key, value) {
  return {
    key,
    value: {
      boolValue: Boolean(value)
    }
  };
}

function jsonAttribute(key, value) {
  return stringAttribute(key, JSON.stringify(value));
}
