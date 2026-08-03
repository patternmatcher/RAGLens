import { jaccard, tokenize, uniqueTerms } from './tokenize.js';

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /reveal (the )?(system|developer) prompt/i,
  /exfiltrate|secret|api key|credential/i,
  /you are now|act as an unrestricted/i,
  /delete files|run shell|call tool/i
];

const SENSITIVE_PATTERNS = [
  /email|phone|address|ssn|national insurance/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/
];

const UNSAFE_QUERY_PATTERNS = [
  /\b(?:private|secret|api|signing|encryption)\s+key\b/i,
  /\b(?:reveal|dump|export|list)\b.{0,40}\b(?:payroll|credentials?|secrets?|personal records?)\b/i,
  /\bignore\b.{0,30}\b(?:polic(?:y|ies)|instructions?|controls?)\b/i
];

export function evaluateRun({ question, answerText, citations, retrieved, retrievalMatches = retrieved, expectedSource, expectedSources, expectedAnswer, abstained = false }) {
  const claims = (abstained ? [] : splitClaims(answerText)).map((text, index) =>
    evaluateClaim(text, index, citations, retrieved)
  );

  const supportedScore = claims.length
    ? claims.reduce((sum, claim) => sum + claimScore(claim.status), 0) / claims.length
    : 0;
  const citationCoverage = claims.length
    ? claims.filter((claim) => claim.citations.length).length / claims.length
    : 0;
  const contextRelevance = retrieved.length
    ? retrieved.reduce((sum, item) => sum + item.coverage, 0) / retrieved.length
    : 0;
  const retrievalConfidence = retrieved[0]?.score || 0;
  const redundancy = computeRedundancy(retrieved);
  const answerTerms = uniqueTerms(answerText);
  const queryTerms = uniqueTerms(question);
  const answerFocus = queryTerms.length ? jaccard(answerTerms, queryTerms) : 0;
  const normalizedExpectedSources = normalizeExpectedSources(expectedSources ?? expectedSource);
  const evalMetrics = computeGroundTruthMetrics(retrievalMatches, normalizedExpectedSources);
  const expectedAnswerMetrics = computeExpectedAnswerMetrics(answerText, expectedAnswer);
  const metrics = {
    retrievalConfidence: round(retrievalConfidence),
    contextRelevance: round(contextRelevance),
    faithfulness: round(supportedScore),
    citationCoverage: round(citationCoverage),
    redundancy: round(redundancy),
    answerFocus: round(answerFocus),
    evalAvailable: normalizedExpectedSources.length > 0,
    precisionAtK: evalMetrics.precisionAtK,
    recallAtK: evalMetrics.recallAtK,
    hitRateAtK: evalMetrics.hitRateAtK,
    mrr: evalMetrics.mrr,
    ndcgAtK: evalMetrics.ndcgAtK,
    expectedSourceCount: evalMetrics.expectedSourceCount,
    expectedSourceHits: evalMetrics.expectedSourceHits,
    sourceRecallAtK: evalMetrics.sourceRecallAtK,
    allSourceRecallAtK: evalMetrics.allSourceRecallAtK,
    expectedAnswerAvailable: Boolean(expectedAnswer),
    expectedAnswerCoverage: expectedAnswerMetrics.coverage,
    expectedAnswerSimilarity: expectedAnswerMetrics.similarity,
    abstained
  };
  const warnings = buildWarnings({ claims, retrieved, redundancy, retrievalConfidence, expectedAnswerMetrics });

  return {
    claims,
    metrics,
    expectedAnswer: expectedAnswerMetrics.details,
    warnings,
    failureSummary: summarizeFailure({ metrics, warnings, expectedSources: normalizedExpectedSources })
  };
}

export function inspectChunksForRisks(chunks) {
  return chunks.flatMap((chunk) => {
    const hits = INJECTION_PATTERNS.filter((pattern) => pattern.test(inspectionText(chunk)));
    return hits.length
      ? [
          {
            chunkId: chunk.id,
            label: chunk.label,
            severity: 'high',
            type: 'prompt-injection',
            message: 'Document context contains prompt-injection-like language.'
          }
        ]
      : [];
  });
}

export function inspectChunksForSensitiveData(chunks) {
  return chunks.flatMap((chunk) => {
    const hits = SENSITIVE_PATTERNS.filter((pattern) => pattern.test(inspectionText(chunk)));
    return hits.length
      ? [
          {
            chunkId: chunk.id,
            label: chunk.label,
            severity: 'medium',
            type: 'sensitive-context',
            message: 'Retrieved context contains sensitive-data-like text.'
          }
        ]
      : [];
  });
}

function inspectionText(chunk) {
  return [
    chunk?.documentTitle,
    chunk?.heading,
    chunk?.section,
    chunk?.label,
    chunk?.documentMetadata?.sourceUri,
    chunk?.text
  ].filter(Boolean).join('\n');
}

export function inspectQuestionForRisks(question) {
  return UNSAFE_QUERY_PATTERNS.some((pattern) => pattern.test(String(question || '')))
    ? [{
        severity: 'high',
        type: 'unsafe-query-intent',
        message: 'The query requests secret or sensitive material, or attempts to bypass policy. Retrieval and fallback output were withheld.'
      }]
    : [];
}

function evaluateClaim(text, index, citations, retrieved) {
  const cleanText = text.replace(/\[[^\]]+\]/g, '').trim();
  const claimTerms = tokenize(cleanText);
  const citedChunkIds = citations
    .filter((citation) => citation.claimIndex === index)
    .map((citation) => citation.chunkId);

  let best = { chunkId: null, overlap: 0 };
  let citedOverlap = 0;
  const sourceSupport = [];
  for (const item of retrieved) {
    const overlap = chunkSupportsClaim(cleanText, claimTerms, item.chunk);
    const support = {
      chunkId: item.chunk.id,
      cited: citedChunkIds.includes(item.chunk.id),
      overlap: round(overlap),
      status: supportStatus(overlap),
      confidence: supportConfidence(overlap)
    };
    sourceSupport.push(support);
    if (overlap > best.overlap) {
      best = { chunkId: item.chunk.id, overlap };
    }
    if (support.cited) {
      citedOverlap = Math.max(citedOverlap, overlap);
    }
  }

  const supportOverlap = citedChunkIds.length ? citedOverlap : best.overlap;
  const status = supportStatus(supportOverlap);
  const confidence = supportConfidence(supportOverlap);

  return {
    index,
    text: cleanText,
    status,
    confidence,
    bestChunkId: best.chunkId,
    citedSupport: round(citedOverlap),
    sourceSupport,
    citations: citedChunkIds
  };
}

function supportStatus(overlap) {
  return overlap >= 0.5 ? 'supported' : overlap >= 0.24 ? 'partial' : 'unsupported';
}

function supportConfidence(overlap) {
  return round(Math.min(1, overlap * 1.7));
}

function chunkSupportsClaim(cleanText, claimTerms, chunk) {
  const normalizedClaim = cleanText.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s-]/g, '').trim();
  const normalizedChunk = String(chunk.text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s-]/g, ' ');

  if (normalizedClaim && normalizedChunk.includes(normalizedClaim)) {
    return 1;
  }

  return jaccard(claimTerms, chunk.terms || tokenize(chunk.text));
}

function splitClaims(answerText) {
  return String(answerText || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

function claimScore(status) {
  if (status === 'supported') {
    return 1;
  }
  if (status === 'partial') {
    return 0.55;
  }
  return 0;
}

function computeRedundancy(retrieved) {
  if (retrieved.length < 2) {
    return 0;
  }

  let total = 0;
  let pairs = 0;
  for (let left = 0; left < retrieved.length; left += 1) {
    for (let right = left + 1; right < retrieved.length; right += 1) {
      total += jaccard(retrieved[left].chunk.terms || [], retrieved[right].chunk.terms || []);
      pairs += 1;
    }
  }

  return pairs ? total / pairs : 0;
}

function buildWarnings({ claims, retrieved, redundancy, retrievalConfidence, expectedAnswerMetrics }) {
  const warnings = [];
  const sourceConflict = detectConflictingSources(retrieved);

  if (!retrieved.length) {
    warnings.push({
      severity: 'high',
      type: 'no-context',
      message: 'No chunks matched the query. Retrieval failed before generation.'
    });
  }
  if (retrievalConfidence && retrievalConfidence < 0.32) {
    warnings.push({
      severity: 'medium',
      type: 'low-confidence',
      message: 'Top retrieval score is low. The answer may be under-grounded.'
    });
  }
  if (claims.some((claim) => claim.status === 'unsupported')) {
    warnings.push({
      severity: 'high',
      type: 'unsupported-claim',
      message: 'At least one answer claim is not supported by retrieved context.'
    });
  }
  if (claims.some((claim) => !claim.citations.length)) {
    warnings.push({
      severity: 'medium',
      type: 'missing-citation',
      message: 'At least one answer claim has no citation.'
    });
  }
  if (expectedAnswerMetrics.available && expectedAnswerMetrics.coverage < 0.45) {
    warnings.push({
      severity: 'high',
      type: 'expected-answer-mismatch',
      message: `Answer misses expected-answer terms: ${expectedAnswerMetrics.details.missingTerms.slice(0, 8).join(', ')}.`,
      matchedTerms: expectedAnswerMetrics.details.matchedTerms,
      missingTerms: expectedAnswerMetrics.details.missingTerms
    });
  }
  if (sourceConflict) {
    warnings.push({
      severity: 'medium',
      type: 'conflicting-sources',
      message: `Retrieved context appears to mix current and stale or contradictory source language: ${sourceConflict.labels.join(', ')}.`,
      chunkIds: sourceConflict.chunkIds,
      labels: sourceConflict.labels
    });
  }
  if (redundancy > 0.38) {
    warnings.push({
      severity: 'medium',
      type: 'redundant-context',
      message: 'Retrieved chunks are highly similar. Try smaller chunks or hybrid search.'
    });
  }

  return warnings;
}

function computeGroundTruthMetrics(retrieved, expectedSources) {
  if (!expectedSources.length) {
    return {
      precisionAtK: 0,
      recallAtK: 0,
      hitRateAtK: 0,
      mrr: 0,
      ndcgAtK: 0,
      expectedSourceCount: 0,
      expectedSourceHits: 0,
      sourceRecallAtK: 0,
      allSourceRecallAtK: 0
    };
  }

  const expected = expectedSources.map((source) => source.toLowerCase());
  const relevantRanks = retrieved.filter((item) => matchesExpectedSource(item.chunk?.documentTitle, expected)).map((item) => item.rank);
  const expectedSourceHits = expected.filter((source) => retrieved.some(
    (item) => String(item.chunk?.documentTitle || '').toLowerCase().includes(source)
  )).length;

  return {
    precisionAtK: round(relevantRanks.length / Math.max(1, retrieved.length)),
    recallAtK: relevantRanks.length ? 1 : 0,
    hitRateAtK: relevantRanks.length ? 1 : 0,
    mrr: relevantRanks.length ? round(1 / Math.min(...relevantRanks)) : 0,
    ndcgAtK: computeNdcg(retrieved, expected),
    expectedSourceCount: expected.length,
    expectedSourceHits,
    sourceRecallAtK: round(expectedSourceHits / expected.length),
    allSourceRecallAtK: expectedSourceHits === expected.length ? 1 : 0
  };
}

function computeNdcg(retrieved, expectedSources) {
  const seenSources = new Set();
  const relevance = retrieved.map((item) => {
    const title = String(item.chunk?.documentTitle || '').toLowerCase();
    const source = expectedSources.find((expected) => title.includes(expected));
    if (!source || seenSources.has(source)) return 0;
    seenSources.add(source);
    return 1;
  });
  const dcg = relevance.reduce((sum, relevant, index) => sum + relevant / Math.log2(index + 2), 0);
  const idealCount = Math.min(expectedSources.length, retrieved.length);
  const idcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return idcg ? round(dcg / idcg) : 0;
}

function normalizeExpectedSources(value) {
  const sources = Array.isArray(value) ? value : [value];
  return [...new Set(sources.map((source) => String(source || '').trim()).filter(Boolean))];
}

function matchesExpectedSource(documentTitle, expectedSources) {
  const title = String(documentTitle || '').toLowerCase();
  return expectedSources.some((source) => title.includes(source));
}

function computeExpectedAnswerMetrics(answerText, expectedAnswer) {
  const expectedTerms = uniqueTerms(expectedAnswer);
  if (!expectedTerms.length) {
    return {
      available: false,
      coverage: 0,
      similarity: 0,
      details: {
        expectedTerms: [],
        matchedTerms: [],
        missingTerms: []
      }
    };
  }

  const answerTerms = new Set(uniqueTerms(answerText));
  const matchedTerms = expectedTerms.filter((term) => answerTerms.has(term));
  const missingTerms = expectedTerms.filter((term) => !answerTerms.has(term));

  return {
    available: true,
    coverage: round(matchedTerms.length / expectedTerms.length),
    similarity: round(jaccard([...answerTerms], expectedTerms)),
    details: {
      expectedTerms,
      matchedTerms,
      missingTerms
    }
  };
}

function detectConflictingSources(retrieved) {
  const stale = [];
  const current = [];

  for (const item of retrieved) {
    const text = String(item.chunk?.text || '').toLowerCase();
    if (/\bstale|old|previous|deprecated|outdated|superseded\b/.test(text)) {
      stale.push(item);
    }
    if (/\bcurrent|new|updated|latest|production|active\b/.test(text)) {
      current.push(item);
    }
  }

  if (!stale.length || !current.length) {
    return null;
  }

  const conflicting = uniqueByChunkId([...stale, ...current]).slice(0, 6);
  return {
    chunkIds: conflicting.map((item) => item.chunk.id),
    labels: conflicting.map((item) => item.chunk.label || item.chunk.id)
  };
}

function uniqueByChunkId(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const id = item.chunk?.id;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(item);
  }
  return unique;
}

function summarizeFailure({ metrics, warnings, expectedSources }) {
  if (!warnings.length && metrics.faithfulness >= 0.8 && metrics.citationCoverage >= 0.8) {
    return 'No major failure detected. Retrieval, grounding, and citation coverage are healthy for this run.';
  }

  const reasons = warnings.map((warning) => warning.type);
  if (expectedSources.length && metrics.recallAtK === 0) {
    reasons.unshift('expected-source-missing');
  }

  return `Review recommended: ${[...new Set(reasons)].join(', ')}. Check retrieval rank, claim support, and citations before trusting this answer.`;
}

function round(value) {
  return Number(Number(value || 0).toFixed(3));
}
