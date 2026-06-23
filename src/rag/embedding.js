import { tokenize } from './tokenize.js';

export const EMBEDDING_MODEL = 'local-hash-embedding-v1';
export const EMBEDDING_DIMENSIONS = 64;

export function embedText(text, dimensions = EMBEDDING_DIMENSIONS) {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const index = positiveHash(token) % dimensions;
    const sign = positiveHash(`sign:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(token.length, 12) / 12);
  }

  return normalizeVector(vector);
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return 0;
  }

  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }

  return Number(Math.max(-1, Math.min(1, score)).toFixed(6));
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) {
    return vector;
  }
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function positiveHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
