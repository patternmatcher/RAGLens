import { createHash } from 'node:crypto';
import { msSince, nowIso } from '../lib/time.js';
import { evaluateRun, inspectChunksForRisks, inspectChunksForSensitiveData, inspectQuestionForRisks } from './evaluator.js';
import { estimateRunCost } from './cost.js';
import { embedTexts } from './embedding-provider.js';
import { generateAnswer } from './provider.js';
import { expandParentContext } from './parent-context.js';
import { buildPrompt, planQuery } from './query.js';
import { rerankCandidates } from './reranker.js';
import { retrieve } from './retriever.js';
import { tokenize } from './tokenize.js';
import { searchWeb } from './web-fallback.js';

export async function runRagInspection({ question, chunks, config = {}, retrieveContext = null }) {
  const startedAt = performance.now();
  const trace = [];
  const queryStart = performance.now();
  const query = await planQuery(question, config.queryRewrite);
  trace.push({
    key: 'rewrite-query',
    label: 'Rewrite query',
    durationMs: msSince(queryStart),
    detail: `${query.mode === 'openai-compatible' ? 'Model' : 'Deterministic'} rewrite produced ${query.searchQueries.length} search quer${query.searchQueries.length === 1 ? 'y' : 'ies'} and ${query.expansions.length} expansion terms.`
  });

  const searchQueries = query.searchQueries?.length ? query.searchQueries : [query.rewritten || question];
  const embedding = await embedTexts(searchQueries, config.embedding || { provider: 'local' });
  trace.push({
    key: 'embed-query',
    label: 'Embed query',
    durationMs: embedding.latencyMs,
    detail: `${embedding.model} produced ${embedding.vectors.length} query vector${embedding.vectors.length === 1 ? '' : 's'} at ${embedding.dimensions} dimensions with ${embedding.cache.hits} cache hits.`
  });

  const retrievalStart = performance.now();
  const retrievalInput = {
    question: query.rewritten || question,
    queryVariants: searchQueries,
    queryEmbeddings: embedding.vectors,
    chunks,
    topK: config.topK || 6,
    candidateDepth: config.candidateDepth || 24,
    retrievalMode: config.retrievalMode || 'hybrid',
    rerank: config.rerank !== false,
    metadataFilter: config.metadataFilter || {},
    parentContext: config.parentContext === true,
    parentContextMaxTokens: config.parentContextMaxTokens || 1_200,
    queryEmbedding: embedding.vectors[0],
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDimensions: embedding.dimensions
  };
  let retrieval = await resolveRetrieval(retrieveContext, retrievalInput);
  const candidateChunks = (retrieval.candidates || retrieval.results || []).map((result) => result.chunk).filter(Boolean);
  const candidateWarnings = [
    ...inspectChunksForRisks(candidateChunks),
    ...inspectChunksForSensitiveData(candidateChunks)
  ];
  const rerankerEgressBlocked = shouldBlockRerankerEgress(config, candidateWarnings);
  const rerankerWarnings = [];
  const queryWarnings = query.warning ? [query.warning] : [];
  const retrievalWarnings = retrieval.stats?.embeddingProfileMismatches
    ? [{
        severity: 'high',
        type: 'embedding-profile-mismatch',
        message: `${retrieval.stats.embeddingProfileMismatches} indexed chunks used a different embedding model or dimension and were excluded from dense scoring.`
      }]
    : [];

  if (config.rerank !== false && ['http', 'colbert'].includes(config.reranker?.provider) && retrieval.candidates?.length) {
    if (rerankerEgressBlocked) {
      rerankerWarnings.push({
        severity: 'high',
        type: 'reranker-egress-blocked',
        message: 'External reranking was skipped because candidate context contained prompt-injection-like or sensitive-data-like text. Set allowUnsafeProviderEgress=true for this run to override.'
      });
    } else {
      const reranked = await rerankCandidates(query.rewritten || question, retrieval.candidates, {
        ...config.reranker,
        topK: retrievalInput.topK
      });
      retrieval = applyRerankerResult(retrieval, reranked, chunks, retrievalInput);
      if (reranked.warning) rerankerWarnings.push(reranked.warning);
    }
  }
  const fallbackWarnings = [];
  const minConfidence = Number(config.webFallback?.minConfidence ?? 0.32);
  const unsafeQueryWarnings = inspectQuestionForRisks(question);
  let fallback = null;
  let abstentionReason = unsafeQueryWarnings.length ? 'unsafe-query-intent' : retrievalConfidence(retrieval) < minConfidence ? 'low-retrieval-confidence' : '';
  let abstained = Boolean(abstentionReason);

  if (abstentionReason === 'low-retrieval-confidence' && config.webFallback?.enabled === true) {
    try {
      const web = await searchWeb(query.rewritten || question, config.webFallback);
      fallback = {
        type: 'web-search',
        status: web.status,
        resultCount: web.results.length,
        latencyMs: web.latencyMs,
        allowedDomains: config.webFallback.allowedDomains || []
      };
      if (web.results.length) {
        retrieval = applyWebFallback(retrieval, web);
        abstained = false;
        abstentionReason = '';
      }
    } catch (error) {
      fallback = { type: 'web-search', status: 'error', resultCount: 0, latencyMs: 0 };
      fallbackWarnings.push({
        severity: 'medium',
        type: 'web-fallback-error',
        message: `Web fallback failed: ${String(error.message || error).slice(0, 180)}`
      });
    }
  }

  if (abstentionReason === 'low-retrieval-confidence') {
    fallbackWarnings.push({
      severity: 'high',
      type: 'retrieval-abstention',
      message: `RAGLens abstained because retrieval confidence was below ${minConfidence.toFixed(2)} and no approved fallback supplied evidence.`
    });
  }
  const retrievalMs = msSince(retrievalStart);
  trace.push({
    key: 'retrieve',
    label: 'Retrieve context',
    durationMs: retrievalMs,
    detail: `${retrieval.results.length} chunks returned from ${retrieval.stats.indexedChunks} indexed chunks${retrieval.stats.source ? ` via ${retrieval.stats.source}` : ''}.`
  });
  const rerankStage = retrieval.stages?.find((stage) => stage.kind === 'rerank');
  if (rerankStage) {
    trace.push({
      key: 'rerank',
      label: 'Rerank candidates',
      durationMs: Number(rerankStage.latencyMs || 0),
      detail: `${rerankStage.candidateCount} candidates reranked with ${rerankStage.model || 'the configured reranker'}.`
    });
  }
  const retrievedChunks = retrieval.results.map((result) => result.chunk);
  const riskWarnings = inspectChunksForRisks(retrievedChunks);
  const sensitiveWarnings = inspectChunksForSensitiveData(retrievedChunks);
  const providerEgressBlocked = shouldBlockProviderEgress(config, [...riskWarnings, ...sensitiveWarnings]);
  const providerEgressWarnings = providerEgressBlocked
    ? [
        {
          severity: 'high',
          type: 'provider-egress-blocked',
          message: 'Live provider generation was skipped because retrieved context contained prompt-injection-like or sensitive-data-like text. Set allowUnsafeProviderEgress=true for this run to override.'
        }
      ]
    : [];
  trace.push({
    key: 'risk-scan',
    label: 'Scan retrieved context before generation',
    durationMs: 0,
    detail: riskWarnings.length || sensitiveWarnings.length
      ? `${riskWarnings.length + sensitiveWarnings.length} safety review signals found before generation.`
      : 'No prompt-injection-like risk signals found in retrieved chunks before generation.'
  });

  const promptStart = performance.now();
  const prompt = buildPrompt({
    question,
    rewrittenQuery: query.rewritten,
    retrieved: retrieval.results,
    promptTemplate: config.promptTemplate
  });
  const promptTokens = tokenize(prompt, { keepStopwords: true }).length;
  trace.push({
    key: 'build-prompt',
    label: 'Build prompt',
    durationMs: msSince(promptStart),
    detail: `${promptTokens} prompt tokens estimated.`
  });

  const answerStart = performance.now();
  const generation = abstained
    ? abstainedGeneration()
    : await generateAnswer({
        question,
        prompt,
        retrieved: retrieval.results,
        config: {
          ...config,
          provider: providerEgressBlocked ? 'local' : config.provider,
          maxClaims: config.maxClaims || 4,
          temperature: config.temperature || 0
        }
      });
  const answer = { ...generation.answer, abstained };
  const generationMs = msSince(answerStart);
  trace.push({
    key: 'generate',
    label: generation.mode === 'openai-compatible-chat'
      ? 'Generate provider answer'
      : 'Generate grounded answer',
    durationMs: generationMs,
    detail: `${answer.citations.length} citation links attached to answer claims using ${generation.mode}.`
  });

  const evalStart = performance.now();
  const evaluation = evaluateRun({
    question,
    answerText: answer.text,
    citations: answer.citations,
    retrieved: retrieval.results,
    retrievalMatches: retrieval.matches || retrieval.results,
    expectedSource: config.expectedSource,
    expectedSources: config.expectedSources,
    expectedAnswer: config.expectedAnswer,
    abstained
  });
  const evaluationMs = msSince(evalStart);
  trace.push({
    key: 'evaluate',
    label: 'Evaluate grounding',
    durationMs: evaluationMs,
    detail: `${evaluation.claims.length} claims inspected for support and citation coverage.`
  });

  const inputTokens = promptTokens;
  const outputTokens = tokenize(answer.text, { keepStopwords: true }).length;
  const usageInputTokens = generation.providerUsage?.inputTokens || inputTokens;
  const usageOutputTokens = generation.providerUsage?.outputTokens || outputTokens;
  const usageTotalTokens = generation.providerUsage?.totalTokens || usageInputTokens + usageOutputTokens;
  const cost = estimateRunCost({
    provider: config.provider || 'local',
    mode: generation.mode,
    inputTokens: usageInputTokens,
    outputTokens: usageOutputTokens,
    costRates: config.costRates
  });
  const latencyMs = msSince(startedAt);

  return {
    question,
    createdAt: nowIso(),
    config: {
      topK: Number(config.topK || 6),
      candidateDepth: Number(config.candidateDepth || 24),
      maxClaims: Number(config.maxClaims || 4),
      maxOutputTokens: Number(config.maxOutputTokens || 0),
      temperature: Number(config.temperature || 0),
      model: config.model || 'local-extractive-v1',
      provider: config.provider || 'local',
      promptVersion: config.promptVersion || 'default',
      promptTemplateFingerprint: fingerprintText(config.promptTemplate || ''),
      promptTemplatePreview: config.promptLoggingEnabled === false
        ? 'prompt logging disabled'
        : previewText(config.promptTemplate || ''),
      retrievalMode: config.retrievalMode || 'hybrid',
      rerank: config.rerank !== false,
      rerankerProvider: config.reranker?.provider || 'local',
      rerankerModel: config.reranker?.model || 'raglens-heuristic-reranker-v1',
      metadataFilter: config.metadataFilter || {},
      parentContext: config.parentContext === true,
      parentContextMaxTokens: Number(config.parentContextMaxTokens || 1_200),
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimensions: embedding.dimensions,
      queryRewriteProvider: query.provider,
      queryRewriteModel: query.model,
      queryVariantCount: searchQueries.length,
      queryAmbiguous: query.ambiguity?.ambiguous === true,
      abstentionThreshold: minConfidence,
      webFallbackEnabled: config.webFallback?.enabled === true,
      chunkTokens: Number(config.chunkTokens || 0),
      overlapTokens: Number(config.overlapTokens || 0),
      indexedChunks: Number(retrieval.stats.indexedChunks ?? chunks.length),
      avgChunkTokens: averageChunkTokens(chunks),
      mode: generation.mode
    },
    query,
    queryTerms: retrieval.queryTerms,
    retrieval: {
      stages: retrieval.stages || [],
      stats: retrieval.stats || {},
      matches: (retrieval.matches || retrieval.results).map(serializeRetrievedResult),
      abstained,
      fallback,
      abstentionReason
    },
    retrievalEvidence: [...(retrieval.candidates || []), ...retrieval.results]
      .map((result) => result.chunk)
      .filter((chunk, index, chunks) => chunks.findIndex((item) => item.id === chunk.id) === index),
    retrieved: retrieval.results.map(serializeRetrievedResult),
    answer,
    evaluation,
    prompt: config.promptLoggingEnabled === false ? null : { text: prompt },
    warnings: [...generation.warnings, ...providerEgressWarnings, ...queryWarnings, ...rerankerWarnings, ...retrievalWarnings, ...unsafeQueryWarnings, ...fallbackWarnings, ...evaluation.warnings, ...riskWarnings, ...sensitiveWarnings],
    trace,
    usage: {
      inputTokens: usageInputTokens,
      outputTokens: usageOutputTokens,
      totalTokens: usageTotalTokens,
      estimatedCostUsd: cost.estimatedCostUsd,
      cost,
      embeddingMs: embedding.latencyMs,
      embeddingCache: embedding.cache,
      retrievalMs,
      generationMs,
      evaluationMs,
      provider: generation.providerMetadata || null
    },
    latencyMs
  };
}

function fingerprintText(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

function previewText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}...` : normalized;
}

async function resolveRetrieval(retrieveContext, retrievalInput) {
  if (typeof retrieveContext === 'function') {
    const provided = await retrieveContext(retrievalInput);
    if (provided) {
      return provided;
    }
  }

  return retrieve(retrievalInput.question, retrievalInput.chunks, {
    topK: retrievalInput.topK,
    candidateDepth: retrievalInput.candidateDepth,
    retrievalMode: retrievalInput.retrievalMode,
    rerank: retrievalInput.rerank,
    metadataFilter: retrievalInput.metadataFilter,
    queryVariants: retrievalInput.queryVariants,
    queryEmbeddings: retrievalInput.queryEmbeddings,
    parentContext: retrievalInput.parentContext,
    parentContextMaxTokens: retrievalInput.parentContextMaxTokens,
    queryEmbedding: retrievalInput.queryEmbedding,
    embeddingProvider: retrievalInput.embeddingProvider,
    embeddingModel: retrievalInput.embeddingModel,
    embeddingDimensions: retrievalInput.embeddingDimensions
  });
}

function shouldBlockProviderEgress(config, contextWarnings) {
  const provider = String(config.provider || 'local').toLowerCase();
  const usesLiveProvider = ['openai', 'openai-compatible', 'openai-compatible-chat'].includes(provider);
  return usesLiveProvider && config.allowUnsafeProviderEgress !== true && contextWarnings.length > 0;
}

function shouldBlockRerankerEgress(config, contextWarnings) {
  return ['http', 'colbert'].includes(config.reranker?.provider) && config.allowUnsafeProviderEgress !== true && contextWarnings.length > 0;
}

function applyRerankerResult(retrieval, reranked, chunks, retrievalInput) {
  if (!reranked.stage) return retrieval;
  const context = expandParentContext(reranked.results, chunks, {
    enabled: retrievalInput.parentContext,
    maxTokens: retrievalInput.parentContextMaxTokens
  });
  const stages = (retrieval.stages || []).filter((stage) => !['rerank', 'parent', 'context'].includes(stage.kind));
  stages.push(reranked.stage);
  if (context.added) stages.push(parentStage(context.results));
  stages.push(contextStage(context.results));
  return {
    ...retrieval,
    matches: reranked.results,
    results: context.results,
    stages,
    stats: {
      ...retrieval.stats,
      parentContextChunks: context.added,
      contextTokens: context.tokenCount
    }
  };
}

function contextStage(results) {
  return {
    id: 'context',
    kind: 'context',
    name: 'Prompt context selection',
    provider: 'raglens',
    candidateCount: results.length,
    selectedEvidenceIds: results.map((result) => result.chunk.id),
    results: results.map((result) => ({
      evidenceId: result.chunk.id,
      rank: result.rank,
      score: result.rerankScore,
      scores: {
        lexical: result.lexicalScore,
        dense: result.vectorScore,
        fusion: result.rawScore,
        rerank: result.rerankScore,
        coverage: result.coverage
      },
      contextRole: result.contextRole || 'match',
      matchedEvidenceId: result.matchedChunkId || null
    }))
  };
}

function parentStage(results) {
  const parents = results.filter((result) => result.contextRole === 'parent');
  return {
    ...contextStage(parents),
    id: 'parent',
    kind: 'parent',
    name: 'Parent section expansion'
  };
}

function applyWebFallback(retrieval, web) {
  const localResults = retrieval.results || [];
  const combined = [...web.results, ...localResults]
    .filter((result, index, items) => items.findIndex((item) => item.chunk.id === result.chunk.id) === index)
    .map((result, index) => ({ ...result, rank: index + 1 }));
  const stages = (retrieval.stages || []).filter((stage) => stage.kind !== 'context');
  stages.push({
    id: 'web-fallback',
    kind: 'web',
    name: 'Policy-controlled web fallback',
    status: web.status,
    provider: 'searxng-compatible',
    candidateCount: web.results.length,
    latencyMs: web.latencyMs,
    filter: {},
    cache: { status: 'not-applicable', hit: false },
    config: {},
    selectedEvidenceIds: web.results.map((result) => result.chunk.id),
    results: web.results.map((result) => ({
      evidenceId: result.chunk.id,
      rank: result.rank,
      score: result.score,
      scores: { lexical: result.lexicalScore, dense: 0, fusion: result.score, rerank: result.score, coverage: result.coverage }
    }))
  }, contextStage(combined));
  return {
    ...retrieval,
    results: combined,
    matches: combined,
    stages,
    stats: { ...retrieval.stats, webFallbackResults: web.results.length }
  };
}

function retrievalConfidence(retrieval) {
  return Number((retrieval.matches || retrieval.results || [])[0]?.score || 0);
}

function abstainedGeneration() {
  return {
    answer: {
      text: 'The available evidence is not strong enough to answer this question reliably.',
      citations: [],
      abstained: true
    },
    mode: 'abstained',
    warnings: [],
    providerUsage: null,
    providerMetadata: null
  };
}

function serializeRetrievedResult(result) {
  return {
    chunkId: result.chunk.id,
    rank: result.rank,
    score: result.score,
    rawScore: Number(Number(result.rawScore || 0).toFixed(3)),
    lexicalScore: Number(result.lexicalScore || 0),
    similarityScore: Number(result.similarityScore || 0),
    rerankScore: Number(Number(result.rerankScore || 0).toFixed(3)),
    coverage: Number(Number(result.coverage || 0).toFixed(3)),
    novelty: Number(result.novelty || 0),
    matchedTerms: result.matchedTerms || [],
    missingTerms: result.missingTerms || [],
    contextRole: result.contextRole || 'match',
    matchedChunkId: result.matchedChunkId || null
  };
}

function averageChunkTokens(chunks) {
  if (!chunks.length) {
    return 0;
  }

  const total = chunks.reduce((sum, chunk) => sum + Number(chunk.tokenCount || 0), 0);
  return Number((total / chunks.length).toFixed(1));
}
