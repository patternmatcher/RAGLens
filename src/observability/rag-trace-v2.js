export const RAG_TRACE_SCHEMA_VERSION = 'tracelens.rag-trace/v2';

export function buildRagTraceV2(run, options = {}) {
  const includeContent = options.includeContent === true;
  const evidence = evidenceItems(run).map((item) => evidenceItem(item, includeContent));
  const results = (run.retrieved || []).map(retrievalResult);
  const retrievalStages = run.retrieval?.stages?.length ? run.retrieval.stages.map((stage) => exportStage(stage, includeContent)) : [
    {
      id: 'retrieval',
      kind: retrievalKind(run.config?.retrievalMode),
      name: `${run.config?.retrievalMode || 'hybrid'} candidate retrieval`,
      status: results.length ? 'ok' : 'warning',
      candidateCount: Number(run.config?.indexedChunks || results.length),
      latencyMs: Number(run.usage?.retrievalMs || 0),
      provider: 'raglens',
      model: evidence[0]?.metadata?.embeddingModel || 'local-hash-embedding-v1',
      filter: {},
      cache: {
        status: 'persisted-chunk-embedding',
        hit: true
      },
      config: {
        mode: run.config?.retrievalMode || 'hybrid',
        topK: Number(run.config?.topK || results.length)
      },
      selectedEvidenceIds: results.map((result) => result.evidenceId),
      results
    }
  ];

  if (!run.retrieval?.stages?.length && run.config?.rerank !== false) {
    retrievalStages.push({
      id: 'rerank',
      kind: 'rerank',
      name: 'Rerank candidates',
      status: results.length ? 'ok' : 'skipped',
      candidateCount: results.length,
      latencyMs: 0,
      provider: 'raglens',
      model: 'raglens-heuristic-reranker-v1',
      filter: {},
      cache: { status: 'not-applicable', hit: false },
      config: { strategy: 'coverage-vector-heuristic' },
      selectedEvidenceIds: results.map((result) => result.evidenceId),
      results: results.map((result) => ({
        ...result,
        score: result.scores.rerank
      }))
    });
  }

  if (!run.retrieval?.stages?.length) retrievalStages.push({
    id: 'context',
    kind: 'context',
    name: 'Select prompt context',
    status: results.length ? 'ok' : 'warning',
    candidateCount: results.length,
    latencyMs: 0,
    provider: 'raglens',
    model: '',
    filter: {},
    cache: { status: 'not-applicable', hit: false },
    config: { estimatedTokens: Number(run.usage?.inputTokens || 0) },
    selectedEvidenceIds: results.map((result) => result.evidenceId),
    results
  });

  return {
    schemaVersion: RAG_TRACE_SCHEMA_VERSION,
    traceId: run.id,
    runId: run.id,
    projectId: run.projectId || '',
    name: `RAGLens run ${run.id}`,
    environment: options.environment || 'local',
    startedAt: run.createdAt || '',
    durationMs: Number(run.latencyMs || 0),
    tags: ['rag', 'raglens'],
    producer: {
      name: 'raglens',
      version: '1.0.0',
      service: options.serviceName || 'raglens'
    },
    privacy: {
      redactionProfile: includeContent ? 'not-redacted' : 'content-omitted',
      containsPrivateData: includeContent,
      safeToExport: !includeContent,
      fieldsRedacted: includeContent ? [] : [
        'query.original',
        'query.rewritten',
        'query.expansions',
        'query.decomposed',
        'corpus.expectedSources',
        'retrieval.filter',
        'evidence.documentTitle',
        'evidence.text',
        'evidence.provenance.section',
        'evidence.provenance.sourceUri',
        'answer.text',
        'answer.claims.text',
        'warnings.message'
      ]
    },
    query: {
      original: includeContent ? run.question : '[query content omitted by exporter]',
      rewritten: includeContent ? run.query?.rewritten || '' : '[query content omitted by exporter]',
      expansions: includeContent ? run.query?.expansions || [] : [],
      decomposed: includeContent ? run.query?.subqueries || run.query?.decomposed || [] : [],
      expectedEvidenceIds: expectedEvidenceIds(run),
      ambiguous: run.query?.ambiguity?.ambiguous === true || run.query?.ambiguous === true,
      latencyMs: traceDuration(run, 'rewrite')
    },
    corpus: {
      indexVersion: corpusVersion(run),
      indexedChunks: Number(run.config?.indexedChunks || 0),
      expectedSources: includeContent ? expectedSources(run) : []
    },
    chunking: {
      strategy: 'section-paragraph-token-window',
      maxTokens: Number(run.config?.chunkTokens || 0),
      overlapTokens: Number(run.config?.overlapTokens || 0)
    },
    retrieval: {
      mode: run.config?.retrievalMode || 'hybrid',
      topK: Number(run.config?.topK || 0),
      filter: includeContent ? run.config?.metadataFilter || {} : {},
      abstained: run.retrieval?.abstained === true,
      fallback: run.retrieval?.fallback || null,
      stages: retrievalStages
    },
    evidence,
    generation: {
      status: run.retrieval?.abstained === true ? 'skipped' : 'ok',
      latencyMs: Number(run.usage?.generationMs || 0),
      model: {
        provider: run.config?.provider || 'local',
        model: run.config?.model || 'local-extractive-v1',
        mode: run.config?.mode || 'local-extractive'
      },
      contextEvidenceIds: results.map((result) => result.evidenceId),
      usage: tokenUsage(run)
    },
    answer: {
      text: includeContent ? run.answer?.text || '' : '[answer content omitted by exporter]',
      abstained: run.answer?.abstained === true || run.retrieval?.abstained === true,
      claims: (run.evaluation?.claims || []).map((claim, index) => ({
        id: `claim_${Number(claim.index ?? index) + 1}`,
        text: includeContent ? claim.text || '' : '[claim content omitted by exporter]',
        status: normalizeClaimStatus(claim.status),
        evidenceIds: claim.citations?.length ? claim.citations : [claim.bestChunkId].filter(Boolean),
        confidence: Number(claim.confidence || 0),
        unsupportedReason: claim.status === 'unsupported' ? 'No retrieved evidence met the support threshold.' : ''
      }))
    },
    evaluations: exportedEvaluations(run),
    warnings: (run.warnings || []).map((warning) => ({
      type: warning.type || 'raglens-warning',
      severity: normalizeSeverity(warning.severity),
      message: includeContent ? warning.message || 'RAGLens reported a run warning.' : 'Warning details omitted by exporter.',
      stageId: warning.stepId || '',
      evidenceIds: [warning.chunkId, ...(warning.chunkIds || [])].filter(Boolean)
    })),
    usage: {
      ...tokenUsage(run),
      embeddingMs: Number(run.usage?.embeddingMs || 0),
      embeddingCache: run.usage?.embeddingCache || null,
      retrievalMs: Number(run.usage?.retrievalMs || 0),
      generationMs: Number(run.usage?.generationMs || 0),
      evaluationMs: Number(run.usage?.evaluationMs || 0),
      totalMs: Number(run.latencyMs || 0),
      estimatedCostUsd: Number(run.usage?.estimatedCostUsd || 0)
    }
  };
}

function evidenceItems(run) {
  const hydrated = new Map((run.retrieved || []).map((item) => [item.chunkId, item]));
  const documents = new Map((run.evidenceSnapshot?.documents || []).map((document) => [document.id, document]));
  for (const chunk of run.evidenceSnapshot?.chunks || []) {
    if (hydrated.has(chunk.id)) continue;
    hydrated.set(chunk.id, {
      chunkId: chunk.id,
      chunk,
      document: documents.get(chunk.documentId) || null
    });
  }
  return [...hydrated.values()];
}

export function validateRagTraceV2(trace) {
  const errors = [];
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return invalid('RAG trace must be an object.');
  if (trace.schemaVersion !== RAG_TRACE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${RAG_TRACE_SCHEMA_VERSION}.`);
  for (const field of ['traceId', 'runId']) requireString(trace[field], field, errors);
  requireString(trace.producer?.name, 'producer.name', errors);
  requireString(trace.query?.original, 'query.original', errors);
  if (!Array.isArray(trace.retrieval?.stages) || !trace.retrieval.stages.length) errors.push('retrieval.stages must not be empty.');
  if (!Array.isArray(trace.evidence)) errors.push('evidence must be an array.');
  requireString(trace.answer?.text, 'answer.text', errors);
  if (!Array.isArray(trace.answer?.claims)) errors.push('answer.claims must be an array.');
  return { ok: errors.length === 0, errors, warnings: [] };
}

function evidenceItem(item, includeContent) {
  const chunk = item.chunk || {};
  const document = item.document || {};
  return {
    id: item.chunkId,
    documentId: document.id || chunk.documentId || 'unknown-document',
    documentTitle: includeContent ? document.title || chunk.documentTitle || item.chunkId : '[metadata omitted by exporter]',
    chunkId: item.chunkId,
    stableChunkId: chunk.stableChunkId || item.chunkId,
    text: includeContent ? chunk.text || '' : '[content omitted by exporter]',
    metadata: {
      sourceType: document.sourceType || '',
      documentChecksum: document.checksum || '',
      tokenCount: Number(chunk.tokenCount || 0),
      embeddingModel: chunk.embeddingModel || '',
      sensitivity: document.metadata?.sensitivity || 'internal',
      contextRole: item.contextRole || '',
      matchedChunkId: item.matchedChunkId || ''
    },
    provenance: {
      section: includeContent ? chunk.section || chunk.heading || '' : '',
      page: chunk.page ?? null,
      pageStart: chunk.pageStart ?? chunk.page ?? null,
      pageEnd: chunk.pageEnd ?? chunk.page ?? null,
      sourceUri: includeContent ? document.metadata?.sourceUri || chunk.documentMetadata?.sourceUri || '' : '',
      extractionMethod: document.metadata?.pdfExtraction?.method || document.metadata?.extraction?.method || document.metadata?.method || '',
      characterStart: chunk.characterStart ?? null,
      characterEnd: chunk.characterEnd ?? null
    }
  };
}

function exportStage(stage, includeContent) {
  if (includeContent) return stage;
  return {
    ...stage,
    filter: {},
    config: sanitizeStageConfig(stage.config)
  };
}

function sanitizeStageConfig(config = {}) {
  return Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    !/query|text|title|section|content|prompt/i.test(key) && isScalarOrNumericArray(value)
  ));
}

function isScalarOrNumericArray(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    || (Array.isArray(value) && value.every((item) => typeof item === 'number'));
}

function retrievalResult(item) {
  return {
    evidenceId: item.chunkId,
    rank: Number(item.rank || 1),
    score: Number(item.score || 0),
    scores: {
      lexical: Number(item.lexicalScore || 0),
      dense: Number(item.similarityScore || 0),
      fusion: Number(item.rawScore || 0),
      rerank: Number(item.rerankScore || item.score || 0),
      coverage: Number(item.coverage || 0),
      novelty: Number(item.novelty || 0)
    }
  };
}

function exportedEvaluations(run) {
  const metrics = run.evaluation?.metrics || {};
  return {
    groundedness: metric(metrics.faithfulness),
    faithfulness: metric(metrics.faithfulness),
    citationCoverage: metric(metrics.citationCoverage),
    retrievalRecall: metric(metrics.recallAtK),
    precisionAtK: metric(metrics.precisionAtK),
    sourceRecallAtK: metric(metrics.sourceRecallAtK),
    allSourceRecallAtK: metric(metrics.allSourceRecallAtK),
    hitRateAtK: metric(metrics.hitRateAtK),
    mrr: metric(metrics.mrr),
    ndcgAtK: metric(metrics.ndcgAtK),
    contextRelevance: metric(metrics.contextRelevance),
    retrievalConfidence: metric(metrics.retrievalConfidence),
    answerFocus: metric(metrics.answerFocus)
  };
}

function tokenUsage(run) {
  return {
    inputTokens: Number(run.usage?.inputTokens || 0),
    outputTokens: Number(run.usage?.outputTokens || 0),
    totalTokens: Number(run.usage?.totalTokens || 0)
  };
}

function traceDuration(run, key) {
  return Number((run.trace || []).find((step) => String(step.key || '').includes(key))?.durationMs || 0);
}

function expectedSources(run) {
  const value = run.config?.expectedSources || run.config?.expectedSource || [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function expectedEvidenceIds(run) {
  const sources = expectedSources(run).map((value) => String(value).toLowerCase());
  return (run.retrieved || [])
    .filter((item) => sources.some((source) => String(item.document?.title || '').toLowerCase().includes(source)))
    .map((item) => item.chunkId);
}

function corpusVersion(run) {
  const checksums = (run.retrieved || []).map((item) => item.document?.checksum).filter(Boolean).sort();
  return checksums.length ? checksums.join(':') : 'unknown';
}

function retrievalKind(mode) {
  if (mode === 'keyword') return 'sparse';
  if (mode === 'vector') return 'dense';
  return 'fusion';
}

function normalizeClaimStatus(status) {
  return ['supported', 'partial', 'unsupported', 'uncited', 'unknown'].includes(status) ? status : 'unknown';
}

function normalizeSeverity(severity) {
  return ['info', 'low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'medium';
}

function metric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${path} must be a non-empty string.`);
}

function invalid(error) {
  return { ok: false, errors: [error], warnings: [] };
}
