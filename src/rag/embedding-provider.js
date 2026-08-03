import { createHash } from 'node:crypto';
import { nowIso } from '../lib/time.js';
import { fetchNoRedirect, readJsonResponse } from '../security/http-client.js';
import { EMBEDDING_MODEL, embedText } from './embedding.js';

const MAX_DIMENSIONS = 8_192;

export class EmbeddingCache {
  constructor(entries = [], maxEntries = 10_000) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
    for (const entry of entries) {
      if (validCacheEntry(entry)) this.entries.set(entry.key, { ...entry });
    }
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.lastUsedAt = nowIso();
    return entry;
  }

  set(key, value) {
    this.entries.set(key, { key, ...value, createdAt: value.createdAt || nowIso(), lastUsedAt: nowIso() });
    this.trim();
  }

  toJSON() {
    return [...this.entries.values()].sort((left, right) =>
      String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || ''))
    );
  }

  trim() {
    if (this.entries.size <= this.maxEntries) return;
    const oldest = this.toJSON().slice(this.maxEntries);
    for (const entry of oldest) this.entries.delete(entry.key);
  }
}

export async function embedTexts(texts, options = {}) {
  const provider = options.provider || 'local';
  const model = provider === 'local' ? EMBEDDING_MODEL : options.model;
  const cache = options.cache || null;
  const projectId = options.projectId || '';
  const inputs = texts.map((text) => String(text || ''));
  const keys = inputs.map((text) => embeddingCacheKey({ projectId, provider, model, text }));
  const vectors = Array(inputs.length);
  const misses = [];
  let cacheHits = 0;

  keys.forEach((key, index) => {
    const cached = cache?.get(key);
    if (cached?.provider === provider && cached?.model === model) {
      vectors[index] = [...cached.embedding];
      cacheHits += 1;
    } else {
      misses.push(index);
    }
  });

  const startedAt = performance.now();
  for (let offset = 0; offset < misses.length; offset += Math.max(1, Number(options.batchSize || 32))) {
    const batchIndexes = misses.slice(offset, offset + Math.max(1, Number(options.batchSize || 32)));
    const batchInputs = batchIndexes.map((index) => inputs[index]);
    const batchVectors = provider === 'local'
      ? batchInputs.map((text) => embedText(text))
      : await fetchEmbeddings(batchInputs, options);
    validateEmbeddingBatch(batchVectors, batchInputs.length);

    batchIndexes.forEach((index, batchIndex) => {
      const embedding = batchVectors[batchIndex];
      vectors[index] = embedding;
      cache?.set(keys[index], {
        projectId,
        provider,
        model,
        dimensions: embedding.length,
        embedding
      });
    });
  }

  const dimensions = vectors[0]?.length || 0;
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error('Embedding provider returned vectors with inconsistent dimensions.');
  }

  return {
    vectors,
    provider,
    model,
    dimensions,
    cache: {
      hits: cacheHits,
      misses: misses.length,
      hitRate: inputs.length ? Number((cacheHits / inputs.length).toFixed(3)) : 0
    },
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
}

export async function embedChunks(chunks, options = {}) {
  if (!chunks.length) return { chunks, metrics: emptyMetrics(options) };
  const result = await embedTexts(chunks.map((chunk) => chunk.text), options);
  const embeddedAt = nowIso();
  return {
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: result.vectors[index],
      embeddingProvider: result.provider,
      embeddingModel: result.model,
      embeddingDimensions: result.dimensions,
      embeddedAt
    })),
    metrics: result
  };
}

export function embeddingCacheKey({ projectId = '', provider, model, text }) {
  return `sha256:${createHash('sha256').update([projectId, provider, model, text].join('\n')).digest('hex')}`;
}

async function fetchEmbeddings(inputs, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this runtime.');
  if (!options.baseUrl) throw new Error('Embedding provider base URL is not configured.');
  if (!options.model) throw new Error('Embedding provider model is not configured.');

  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await fetchNoRedirect(fetchImpl, embeddingUrl(options.baseUrl), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: options.model, input: inputs })
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    const payload = await readJsonResponse(response, {
      label: 'Embedding provider',
      maxBytes: 16 * 1024 * 1024
    });
    if (Array.isArray(payload.data) && payload.data.length > inputs.length) {
      throw new Error('Embedding provider returned more vectors than requested.');
    }
    const rows = Array.isArray(payload.data) ? [...payload.data] : [];
    rows.sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
    return rows.map((row) => row.embedding);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Embedding request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateEmbeddingBatch(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error(`Embedding provider returned ${vectors?.length || 0} vectors for ${expectedCount} inputs.`);
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length || vector.length > MAX_DIMENSIONS || vector.some((value) => !Number.isFinite(Number(value)))) {
      throw new Error('Embedding provider returned an invalid vector.');
    }
  }
}

function embeddingUrl(baseUrl) {
  const value = String(baseUrl).replace(/\/+$/, '');
  return value.endsWith('/embeddings') ? value : `${value}/embeddings`;
}

function validCacheEntry(entry) {
  return Boolean(
    entry && typeof entry.key === 'string' && typeof entry.provider === 'string' &&
    typeof entry.model === 'string' && Array.isArray(entry.embedding) && entry.embedding.length &&
    entry.embedding.every((value) => Number.isFinite(Number(value)))
  );
}

function emptyMetrics(options) {
  return {
    vectors: [],
    provider: options.provider || 'local',
    model: options.model || EMBEDDING_MODEL,
    dimensions: 0,
    cache: { hits: 0, misses: 0, hitRate: 0 },
    latencyMs: 0
  };
}
