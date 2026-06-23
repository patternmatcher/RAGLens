const STOPWORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves'
]);

export function tokenize(text, options = {}) {
  const { keepStopwords = false } = options;
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .match(/[a-z0-9][a-z0-9-]{1,}/g);

  if (!tokens) {
    return [];
  }

  return tokens
    .map(stem)
    .filter((token) => token.length > 1)
    .filter((token) => keepStopwords || !STOPWORDS.has(token));
}

export function termCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

export function uniqueTerms(text) {
  return [...new Set(tokenize(text))];
}

export function jaccard(aTerms, bTerms) {
  const a = new Set(aTerms);
  const b = new Set(bTerms);
  if (!a.size && !b.size) {
    return 0;
  }

  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }

  return intersection / (a.size + b.size - intersection);
}

function stem(token) {
  if (token.length > 5 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 6 && token.endsWith('ing')) {
    return token.slice(0, -3);
  }
  if (token.length > 5 && token.endsWith('ed')) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith('s')) {
    return token.slice(0, -1);
  }
  return token;
}
