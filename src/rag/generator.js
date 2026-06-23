import { tokenize, uniqueTerms } from './tokenize.js';
import { sourceLabelForChunk } from './source-label.js';

export function generateGroundedAnswer(question, retrieved, options = {}) {
  const maxClaims = Math.min(Math.max(Number(options.maxClaims || 4), 1), 8);
  const temperature = Math.min(Math.max(Number(options.temperature || 0), 0), 1);
  const queryTerms = uniqueTerms(question);
  const candidateSentences = [];

  for (const item of retrieved) {
    const sentences = splitSentences(item.chunk.text);
    for (const sentence of sentences) {
      const score = sentenceScore(sentence, queryTerms, item);
      if (score > 0) {
        candidateSentences.push({
          sentence: sentence.trim(),
          score,
          chunkId: item.chunk.id,
          sourceLabel: sourceLabel(item)
        });
      }
    }
  }

  const chosen = candidateSentences
    .sort((a, b) => b.score - a.score)
    .filter((_, index) => temperature > 0.55 || index < Math.max(maxClaims * 2, maxClaims))
    .slice(0, maxClaims);

  if (!chosen.length) {
    return {
      text:
        'RAGLens could not build a grounded answer because the retriever did not return relevant context. Try changing the query, adding documents, or increasing top-k.',
      citations: []
    };
  }

  const citations = chosen.map((item, index) => ({
    claimIndex: index,
    chunkId: item.chunkId,
    label: item.sourceLabel
  }));
  const claims = chosen.map((item) => `${rewriteSentence(item.sentence)} [${item.sourceLabel}]`);

  return {
    text: claims.join(' '),
    citations
  };
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24 && sentence.length < 320);
}

function sentenceScore(sentence, queryTerms, item) {
  const sentenceTerms = new Set(tokenize(sentence));
  let matches = 0;
  for (const term of queryTerms) {
    if (sentenceTerms.has(term)) {
      matches += 1;
    }
  }

  return matches * 1.6 + causalBoost(sentence, queryTerms) + item.score + item.coverage * 2 + item.novelty * 0.25;
}

function causalBoost(sentence, queryTerms) {
  const asksCause = queryTerms.some((term) => ['caus', 'cause', 'root', 'why'].includes(term));
  if (!asksCause) {
    return 0;
  }
  return /\b(root cause|caused by|because|due to|remained|remains|resulted from)\b/i.test(sentence) ? 3 : 0;
}

function rewriteSentence(sentence) {
  return sentence
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceLabel(item) {
  return sourceLabelForChunk(item.chunk);
}
