export function expandParentContext(matches, chunks, options = {}) {
  const rankedMatches = matches.map((result) => ({ ...result, contextRole: 'match' }));
  if (options.enabled !== true || !rankedMatches.length) {
    return { results: rankedMatches, added: 0, tokenCount: tokenTotal(rankedMatches) };
  }

  const maxTokens = Math.min(Math.max(Number(options.maxTokens || 1_200), 200), 8_000);
  const selected = [];
  const selectedIds = new Set();
  let tokenCount = 0;

  for (const match of rankedMatches) {
    if (!selectedIds.has(match.chunk.id)) {
      selected.push(match);
      selectedIds.add(match.chunk.id);
      tokenCount += Number(match.chunk.tokenCount || 0);
    }

    const siblings = chunks
      .filter((chunk) => isSibling(chunk, match.chunk) && !selectedIds.has(chunk.id))
      .sort((left, right) =>
        Math.abs(Number(left.index || 0) - Number(match.chunk.index || 0)) -
          Math.abs(Number(right.index || 0) - Number(match.chunk.index || 0)) ||
        Number(left.index || 0) - Number(right.index || 0)
      );

    for (const chunk of siblings) {
      const chunkTokens = Number(chunk.tokenCount || 0);
      if (tokenCount + chunkTokens > maxTokens) continue;
      selected.push(parentResult(match, chunk));
      selectedIds.add(chunk.id);
      tokenCount += chunkTokens;
    }
  }

  return {
    results: selected.map((result, index) => ({ ...result, rank: index + 1 })),
    added: selected.length - rankedMatches.length,
    tokenCount
  };
}

function isSibling(candidate, child) {
  return candidate.documentId === child.documentId &&
    candidate.section === child.section &&
    candidate.id !== child.id;
}

function parentResult(match, chunk) {
  return {
    ...match,
    chunk,
    contextRole: 'parent',
    matchedChunkId: match.chunk.id,
    score: Number(Math.max(0, Number(match.score || 0) * 0.98).toFixed(3)),
    rawScore: Number(match.rawScore || 0),
    lexicalScore: 0,
    vectorScore: 0,
    similarityScore: 0,
    rerankScore: Number(match.rerankScore || 0),
    coverage: 0,
    novelty: 1,
    matchedTerms: [],
    missingTerms: []
  };
}

function tokenTotal(results) {
  return results.reduce((sum, result) => sum + Number(result.chunk?.tokenCount || 0), 0);
}
