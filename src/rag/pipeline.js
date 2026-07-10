import { createHash } from 'node:crypto';
import { msSince, nowIso } from '../lib/time.js';
import { evaluateRun, inspectChunksForRisks, inspectChunksForSensitiveData } from './evaluator.js';
import { estimateRunCost } from './cost.js';
import { generateAnswer } from './provider.js';
import { buildPrompt, rewriteQuery } from './query.js';
import { retrieve } from './retriever.js';
import { tokenize } from './tokenize.js';

export async function runRagInspection({ question, chunks, config = {}, retrieveContext = null }) {
  const startedAt = performance.now();
  const trace = [];
  const queryStart = performance.now();
  const query = rewriteQuery(question);
  trace.push({
    key: 'rewrite-query',
    label: 'Rewrite query',
    durationMs: msSince(queryStart),
    detail: query.expansions.length
      ? `Expanded query with ${query.expansions.length} related terms.`
      : 'No query expansion terms were needed.'
  });

  const retrievalStart = performance.now();
  const retrievalInput = {
    question: query.rewritten || question,
    chunks,
    topK: config.topK || 6,
    retrievalMode: config.retrievalMode || 'hybrid',
    rerank: config.rerank !== false
  };
  const retrieval = await resolveRetrieval(retrieveContext, retrievalInput);
  const retrievalMs = msSince(retrievalStart);
  trace.push({
    key: 'retrieve',
    label: 'Retrieve context',
    durationMs: retrievalMs,
    detail: `${retrieval.results.length} chunks returned from ${retrieval.stats.indexedChunks} indexed chunks${retrieval.stats.source ? ` via ${retrieval.stats.source}` : ''}.`
  });
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
  const generation = await generateAnswer({
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
  const answer = generation.answer;
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
    expectedSource: config.expectedSource,
    expectedSources: config.expectedSources,
    expectedAnswer: config.expectedAnswer
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
      chunkTokens: Number(config.chunkTokens || 0),
      overlapTokens: Number(config.overlapTokens || 0),
      indexedChunks: Number(retrieval.stats.indexedChunks ?? chunks.length),
      avgChunkTokens: averageChunkTokens(chunks),
      mode: generation.mode
    },
    query,
    queryTerms: retrieval.queryTerms,
    retrieved: retrieval.results.map((result) => ({
      chunkId: result.chunk.id,
      rank: result.rank,
      score: result.score,
      rawScore: Number(result.rawScore.toFixed(3)),
      lexicalScore: result.lexicalScore,
      similarityScore: result.similarityScore,
      rerankScore: Number(result.rerankScore.toFixed(3)),
      coverage: Number(result.coverage.toFixed(3)),
      novelty: result.novelty,
      matchedTerms: result.matchedTerms,
      missingTerms: result.missingTerms
    })),
    answer,
    evaluation,
    prompt: config.promptLoggingEnabled === false ? null : { text: prompt },
    warnings: [...generation.warnings, ...providerEgressWarnings, ...evaluation.warnings, ...riskWarnings, ...sensitiveWarnings],
    trace,
    usage: {
      inputTokens: usageInputTokens,
      outputTokens: usageOutputTokens,
      totalTokens: usageTotalTokens,
      estimatedCostUsd: cost.estimatedCostUsd,
      cost,
      embeddingMs: 0,
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
    retrievalMode: retrievalInput.retrievalMode,
    rerank: retrievalInput.rerank
  });
}

function shouldBlockProviderEgress(config, contextWarnings) {
  const provider = String(config.provider || 'local').toLowerCase();
  const usesLiveProvider = ['openai', 'openai-compatible', 'openai-compatible-chat'].includes(provider);
  return usesLiveProvider && config.allowUnsafeProviderEgress !== true && contextWarnings.length > 0;
}

function averageChunkTokens(chunks) {
  if (!chunks.length) {
    return 0;
  }

  const total = chunks.reduce((sum, chunk) => sum + Number(chunk.tokenCount || 0), 0);
  return Number((total / chunks.length).toFixed(1));
}
