import { fetchNoRedirect, readJsonResponse } from '../security/http-client.js';

export async function rerankCandidates(question, candidates, options = {}) {
  const topK = Math.min(Math.max(Number(options.topK || 6), 1), 20);
  const provider = options.provider || 'local';
  if (provider === 'local' || !candidates.length) {
    return {
      results: candidates.slice(0, topK).map((candidate, index) => finalizeCandidate(candidate, candidate.rerankScore, index)),
      stage: null,
      warning: null
    };
  }

  const startedAt = performance.now();
  try {
    const scores = await fetchRerankScores(question, candidates, options);
    const ranked = candidates
      .map((candidate, index) => ({ candidate, score: scores.get(index) ?? 0 }))
      .sort((left, right) => right.score - left.score || left.candidate.chunk.id.localeCompare(right.candidate.chunk.id))
      .slice(0, topK);
    const results = ranked.map(({ candidate, score }, index) => finalizeCandidate(candidate, score, index));
    return {
      results,
      stage: {
        id: 'rerank',
        kind: 'rerank',
        name: rerankerName(provider),
        status: 'ok',
        provider,
        model: options.model || 'configured-reranker',
        candidateCount: candidates.length,
        latencyMs: elapsed(startedAt),
        cache: { status: 'miss', hit: false },
        config: { candidateDepth: candidates.length },
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
          }
        }))
      },
      warning: null
    };
  } catch (error) {
    return {
      results: candidates.slice(0, topK).map((candidate, index) => finalizeCandidate(candidate, candidate.rerankScore, index)),
      stage: {
        id: 'rerank',
        kind: 'rerank',
        name: rerankerName(provider),
        status: 'warning',
        provider,
        model: options.model || 'configured-reranker',
        candidateCount: candidates.length,
        latencyMs: elapsed(startedAt),
        cache: { status: 'miss', hit: false },
        config: { candidateDepth: candidates.length },
        selectedEvidenceIds: candidates.slice(0, topK).map((candidate) => candidate.chunk.id),
        results: []
      },
      warning: {
        severity: 'medium',
        type: 'reranker-fallback',
        message: `Configured reranker failed; local ranking was used: ${String(error.message || error).slice(0, 180)}`
      }
    };
  }
}

async function fetchRerankScores(question, candidates, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this runtime.');
  if (!options.baseUrl) throw new Error('Reranker base URL is not configured.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 30_000));
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await fetchNoRedirect(fetchImpl, rerankUrl(options.baseUrl), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model || undefined,
        query: String(question || ''),
        documents: candidates.map((candidate) => candidate.chunk.text),
        top_n: candidates.length,
        return_documents: false
      })
    });
    if (!response.ok) throw new Error(`Reranker returned HTTP ${response.status}.`);
    const payload = await readJsonResponse(response, {
      label: 'Reranker',
      maxBytes: 2 * 1024 * 1024
    });
    const rows = Array.isArray(payload.results) ? payload.results : [];
    if (rows.length > Math.max(candidates.length * 2, 200)) {
      throw new Error('Reranker returned too many result rows.');
    }
    const scores = new Map(rows.map((row) => [Number(row.index), Number(row.relevance_score ?? row.score ?? 0)]));
    if (!scores.size) throw new Error('Reranker response did not contain indexed scores.');
    return scores;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Reranker timed out after ${options.timeoutMs || 30_000}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function finalizeCandidate(candidate, rerankScore, index) {
  const score = Number(rerankScore || 0);
  return {
    ...candidate,
    rank: index + 1,
    rerankScore: score,
    score: Number(Math.max(0, Math.min(1, score <= 1 ? score : score / (score + 4))).toFixed(3)),
    similarityScore: Number(Math.max(0, candidate.vectorScore || 0).toFixed(3)),
    novelty: candidate.novelty ?? 1
  };
}

function rerankUrl(baseUrl) {
  const value = String(baseUrl).replace(/\/$/, '');
  return value.endsWith('/rerank') ? value : `${value}/rerank`;
}

function elapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(2));
}

function rerankerName(provider) {
  return provider === 'colbert' ? 'ColBERT late-interaction rerank' : 'Cross-encoder candidate rerank';
}
