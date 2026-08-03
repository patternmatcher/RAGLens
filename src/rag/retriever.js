import { jaccard, termCounts, tokenize, uniqueTerms } from './tokenize.js';
import { cosineSimilarity, embedText } from './embedding.js';
import { expandParentContext } from './parent-context.js';

const K1 = 1.4;
const B = 0.72;

export function retrieve(question, chunks, options = {}) {
  const topK = Math.min(Math.max(Number(options.topK || 6), 1), 20);
  const candidateDepth = Math.min(Math.max(Number(options.candidateDepth || Math.max(24, topK * 4)), topK), 100);
  const mode = options.retrievalMode || 'hybrid';
  const rerank = options.rerank !== false;
  const queryVariants = Array.isArray(options.queryVariants) && options.queryVariants.length ? options.queryVariants : [question];
  const queryTermsByVariant = queryVariants.map(uniqueTerms);
  const queryTerms = [...new Set(queryTermsByVariant.flat())];
  const queryEmbeddings = Array.isArray(options.queryEmbeddings) && options.queryEmbeddings.length === queryVariants.length
    ? options.queryEmbeddings
    : queryVariants.map(embedText);
  const eligibleChunks = applyMetadataFilter(chunks, options.metadataFilter);

  if (!queryTerms.length || !eligibleChunks.length) {
    return {
      queryTerms,
      results: [],
      stages: [],
      stats: {
        indexedChunks: chunks.length,
        eligibleChunks: eligibleChunks.length,
        filteredOut: chunks.length - eligibleChunks.length,
        avgChunkTokens: 0,
        mode,
        rerank,
        candidateDepth,
        metadataFilter: options.metadataFilter || {}
      }
    };
  }

  const corpusStats = buildCorpusStats(eligibleChunks);
  const embeddingProfileMismatches = eligibleChunks.filter((chunk) => !hasCompatibleEmbedding(chunk, options, queryEmbeddings[0])).length;
  const scored = eligibleChunks
    .map((chunk) => scoreChunkAcrossQueries(chunk, queryTermsByVariant, queryEmbeddings, corpusStats, mode, options))
    .filter((result) => result.rawScore > 0 || result.vectorScore > 0.08);
  const sparseRanked = [...scored].sort((a, b) => b.lexicalScore - a.lexicalScore || stableResultOrder(a, b));
  const denseRanked = [...scored].sort((a, b) => b.vectorScore - a.vectorScore || stableResultOrder(a, b));
  const fusedRanked = [...scored].sort((a, b) => b.rawScore - a.rawScore || stableResultOrder(a, b));
  const selectedRanking = mode === 'keyword' ? sparseRanked : mode === 'vector' ? denseRanked : fusedRanked;
  const candidates = selectedRanking
    .slice(0, candidateDepth)
    .map((result) => ({
      ...result,
      rerankScore: rerank ? rerankScore(result) : result.rawScore
    }));
  const chosen = candidates
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topK);
  const matches = chosen.map((result, index) => ({
      ...result,
      rank: index + 1,
      novelty: noveltyAgainstPrevious(result.chunk.terms, chosen.slice(0, index)),
      score: normalizeScore(result.rerankScore),
      similarityScore: Number(Math.max(0, result.vectorScore).toFixed(3))
    }));
  const context = expandParentContext(matches, eligibleChunks, {
    enabled: options.parentContext === true,
    maxTokens: options.parentContextMaxTokens
  });
  const results = context.results;

  return {
    queryTerms,
    results,
    matches,
    candidates,
    stages: retrievalStages({ mode, rerank, candidateDepth, sparseRanked, denseRanked, fusedRanked, candidates, matches, results, parentContext: options.parentContext === true }),
    stats: {
      indexedChunks: chunks.length,
      eligibleChunks: eligibleChunks.length,
      filteredOut: chunks.length - eligibleChunks.length,
      avgChunkTokens: corpusStats.avgLength,
      mode,
      rerank,
      candidateDepth,
      metadataFilter: options.metadataFilter || {},
      embeddingProfileMismatches,
      parentContextEnabled: options.parentContext === true,
      parentContextChunks: context.added,
      contextTokens: context.tokenCount,
      queryVariantCount: queryVariants.length
    }
  };
}

export function applyMetadataFilter(chunks, filter = {}) {
  const normalized = filter && typeof filter === 'object' ? filter : {};
  return chunks.filter((chunk) => matchesMetadataFilter(chunk, normalized));
}

function matchesMetadataFilter(chunk, filter) {
  const metadata = chunk.documentMetadata || {};
  if (!includesWhenSet(filter.documentIds, chunk.documentId)) return false;
  if (!includesWhenSet(filter.sourceTypes, chunk.sourceType)) return false;
  if (!includesWhenSet(filter.collections, metadata.collection)) return false;
  if (!includesWhenSet(filter.departments, metadata.department)) return false;
  if (!includesWhenSet(filter.versions, metadata.version)) return false;
  if (!includesWhenSet(filter.sensitivities, metadata.sensitivity)) return false;
  if (filter.tags?.length && !filter.tags.some((tag) => (metadata.tags || []).includes(tag))) return false;
  if (filter.effectiveAfter && !dateAtOrAfter(metadata.effectiveDate, filter.effectiveAfter)) return false;
  if (filter.effectiveBefore && !dateAtOrBefore(metadata.effectiveDate, filter.effectiveBefore)) return false;
  const pageStart = Number(chunk.pageStart ?? chunk.page);
  const pageEnd = Number(chunk.pageEnd ?? chunk.page);
  if (filter.pageStart && (!Number.isFinite(pageEnd) || pageEnd < Number(filter.pageStart))) return false;
  if (filter.pageEnd && (!Number.isFinite(pageStart) || pageStart > Number(filter.pageEnd))) return false;
  return true;
}

function includesWhenSet(values, actual) {
  return !values?.length || values.includes(actual);
}

function dateAtOrAfter(actual, boundary) {
  return isCanonicalDate(actual) && isCanonicalDate(boundary) && actual >= boundary;
}

function dateAtOrBefore(actual, boundary) {
  return isCanonicalDate(actual) && isCanonicalDate(boundary) && actual <= boundary;
}

function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function retrievalStages({ mode, rerank, candidateDepth, sparseRanked, denseRanked, fusedRanked, candidates, matches, results, parentContext }) {
  const stages = [];
  if (mode !== 'vector') stages.push(stage('sparse', 'Sparse BM25 candidates', sparseRanked, candidateDepth, 'lexicalScore'));
  if (mode !== 'keyword') stages.push(stage('dense', 'Dense vector candidates', denseRanked, candidateDepth, 'vectorScore'));
  if (mode === 'hybrid') stages.push(stage('fusion', 'Hybrid score fusion', fusedRanked, candidateDepth, 'rawScore'));
  if (rerank) stages.push(stage('rerank', 'Heuristic candidate rerank', candidates, candidateDepth, 'rerankScore', matches));
  if (parentContext) {
    const parents = results.filter((result) => result.contextRole === 'parent');
    stages.push(stage('parent', 'Parent section expansion', parents, parents.length, 'rerankScore', parents));
  }
  stages.push(stage('context', 'Prompt context selection', results, results.length, 'rerankScore', results));
  return stages;
}

function stage(kind, name, items, limit, scoreKey, selectedItems = items.slice(0, limit)) {
  return {
    id: kind,
    kind,
    name,
    provider: 'raglens',
    model: kind === 'rerank' ? 'raglens-heuristic-reranker-v1' : '',
    candidateCount: items.length,
    selectedEvidenceIds: selectedItems.map((item) => item.chunk.id),
    results: items.slice(0, limit).map((item, index) => ({
      evidenceId: item.chunk.id,
      rank: index + 1,
      score: Number(item[scoreKey] || 0),
      scores: {
        lexical: Number(item.lexicalScore || 0),
        dense: Number(item.vectorScore || 0),
        fusion: Number(item.rawScore || 0),
        rerank: Number(item.rerankScore || 0),
        coverage: Number(item.coverage || 0)
      }
    }))
  };
}

function stableResultOrder(left, right) {
  return String(left.chunk.id).localeCompare(String(right.chunk.id));
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

function scoreChunk(chunk, queryTerms, queryEmbedding, corpusStats, mode, embeddingCompatible) {
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
  const vectorScore = embeddingCompatible ? cosineSimilarity(queryEmbedding, chunk.embedding || embedText(chunk.text)) : 0;
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

function scoreChunkAcrossQueries(chunk, queryTermsByVariant, queryEmbeddings, corpusStats, mode, options) {
  const scored = queryTermsByVariant.map((terms, index) =>
    scoreChunk(chunk, terms, queryEmbeddings[index], corpusStats, mode, hasCompatibleEmbedding(chunk, options, queryEmbeddings[index]))
  );
  const best = scored.sort((left, right) => right.rawScore - left.rawScore)[0];
  return {
    ...best,
    lexicalScore: Math.max(...scored.map((result) => result.lexicalScore)),
    vectorScore: Math.max(...scored.map((result) => result.vectorScore)),
    rawScore: Math.max(...scored.map((result) => result.rawScore)),
    coverage: Math.max(...scored.map((result) => result.coverage)),
    matchedTerms: [...new Set(scored.flatMap((result) => result.matchedTerms))],
    missingTerms: [...new Set(scored.flatMap((result) => result.missingTerms))]
  };
}

function hasCompatibleEmbedding(chunk, options, queryEmbedding) {
  const dimensions = Number(chunk.embeddingDimensions || chunk.embedding?.length || 0);
  if (!Array.isArray(queryEmbedding) || !queryEmbedding.length || dimensions !== queryEmbedding.length) return false;
  if (options.embeddingModel && chunk.embeddingModel && options.embeddingModel !== chunk.embeddingModel) return false;
  return true;
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
