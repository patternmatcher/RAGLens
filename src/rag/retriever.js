import { jaccard, termCounts, tokenize, uniqueTerms } from './tokenize.js';
import { cosineSimilarity, embedText } from './embedding.js';

const K1 = 1.4;
const B = 0.72;

export function retrieve(question, chunks, options = {}) {
  const topK = Math.min(Math.max(Number(options.topK || 6), 1), 20);
  const mode = options.retrievalMode || 'hybrid';
  const rerank = options.rerank !== false;
  const queryTerms = uniqueTerms(question);
  const queryEmbedding = embedText(question);

  if (!queryTerms.length || !chunks.length) {
    return {
      queryTerms,
      results: [],
      stats: {
        indexedChunks: chunks.length,
        avgChunkTokens: 0
      }
    };
  }

  const corpusStats = buildCorpusStats(chunks);
  const scored = chunks
    .map((chunk) => scoreChunk(chunk, queryTerms, queryEmbedding, corpusStats, mode))
    .filter((result) => result.rawScore > 0 || result.vectorScore > 0.08)
    .map((result) => ({
      ...result,
      rerankScore: rerank ? rerankScore(result) : result.rawScore
    }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topK)
    .map((result, index, chosen) => ({
      ...result,
      rank: index + 1,
      novelty: noveltyAgainstPrevious(result.chunk.terms, chosen.slice(0, index)),
      score: normalizeScore(result.rerankScore),
      similarityScore: Number(Math.max(0, result.vectorScore).toFixed(3))
    }));

  return {
    queryTerms,
    results: scored,
    stats: {
      indexedChunks: chunks.length,
      avgChunkTokens: corpusStats.avgLength,
      mode,
      rerank
    }
  };
}

function buildCorpusStats(chunks) {
  const docFreq = new Map();
  let totalLength = 0;

  for (const chunk of chunks) {
    totalLength += chunk.terms.length;
    for (const term of new Set(chunk.terms)) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  return {
    chunkCount: chunks.length,
    avgLength: chunks.length ? totalLength / chunks.length : 0,
    docFreq
  };
}

function scoreChunk(chunk, queryTerms, queryEmbedding, corpusStats, mode) {
  const counts = chunk.termCounts || Object.fromEntries(termCounts(chunk.terms || tokenize(chunk.text)));
  const matchedTerms = [];
  const missingTerms = [];
  let rawScore = 0;

  for (const term of queryTerms) {
    const tf = counts[term] || 0;
    if (!tf) {
      missingTerms.push(term);
      continue;
    }

    matchedTerms.push(term);
    const df = corpusStats.docFreq.get(term) || 0;
    const idf = Math.log(1 + (corpusStats.chunkCount - df + 0.5) / (df + 0.5));
    const lengthNorm = K1 * (1 - B + B * ((chunk.terms?.length || 0) / corpusStats.avgLength));
    rawScore += idf * ((tf * (K1 + 1)) / (tf + lengthNorm));
  }

  const coverage = matchedTerms.length / queryTerms.length;
  const density = matchedTerms.length / Math.max(1, new Set(chunk.terms).size);
  const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding || embedText(chunk.text));
  const lexicalScore = rawScore * (1 + coverage * 0.35 + density);
  const hybridScore =
    mode === 'keyword'
      ? lexicalScore
      : mode === 'vector'
        ? Math.max(0, vectorScore) * 5
        : lexicalScore * 0.72 + Math.max(0, vectorScore) * 2.4;

  return {
    chunk,
    rawScore: hybridScore,
    lexicalScore: Number(lexicalScore.toFixed(3)),
    vectorScore,
    coverage,
    matchedTerms,
    missingTerms
  };
}

function rerankScore(result) {
  return result.rawScore + result.coverage * 1.1 + Math.max(0, result.vectorScore) * 0.8;
}

function normalizeScore(score) {
  return Number((score / (score + 4)).toFixed(3));
}

function noveltyAgainstPrevious(terms, previousResults) {
  if (!previousResults.length) {
    return 1;
  }

  const maxOverlap = Math.max(
    ...previousResults.map((result) => jaccard(terms, result.chunk.terms || []))
  );

  return Number(Math.max(0, 1 - maxOverlap).toFixed(3));
}
