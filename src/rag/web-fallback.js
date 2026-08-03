import { createHash } from 'node:crypto';
import { fetchNoRedirect, readJsonResponse } from '../security/http-client.js';
import { redactSecrets } from '../security/redact.js';
import { tokenize, uniqueTerms } from './tokenize.js';

export async function searchWeb(query, options = {}) {
  if (options.enabled !== true) return { results: [], latencyMs: 0, status: 'disabled' };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this runtime.');
  const endpoint = searchUrl(options.baseUrl, query);
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const headers = { Accept: 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await fetchNoRedirect(fetchImpl, endpoint, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}.`);
    const payload = await readJsonResponse(response, {
      label: 'Web search',
      maxBytes: 4 * 1024 * 1024
    });
    const rows = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.items) ? payload.items : [];
    const results = rows
      .slice(0, 40)
      .map((row) => normalizeSearchResult(row, [options.apiKey]))
      .filter((result) => result && domainAllowed(result.url, options.allowedDomains))
      .slice(0, Math.min(Math.max(Number(options.maxResults || 5), 1), 10))
      .map((result, index) => retrievalResult(result, index, query));
    return {
      results,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      status: results.length ? 'ok' : 'empty'
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Web search timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSearchResult(row, knownSecrets) {
  const url = safeResultUrl(row.url || row.link, knownSecrets);
  const text = redactSecrets(cleanText(row.content || row.snippet || row.description), knownSecrets).text.slice(0, 2_000);
  if (!url || !text) return null;
  return {
    url,
    title: redactSecrets(cleanText(row.title || new URL(url).hostname), knownSecrets).text.slice(0, 240),
    text,
    score: normalizedScore(row.score)
  };
}

function retrievalResult(result, index, query) {
  const digest = createHash('sha256').update(`${result.url}\n${result.text}`).digest('hex');
  const terms = uniqueTerms(result.text);
  const queryTerms = uniqueTerms(query);
  const matchedTerms = queryTerms.filter((term) => terms.includes(term));
  const coverage = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
  const score = Math.max(result.score, Math.min(0.85, 0.35 + coverage * 0.5));
  const chunk = {
    id: `web_${digest.slice(0, 12)}`,
    stableChunkId: `sha256:${digest}`,
    documentId: `webdoc_${createHash('sha256').update(result.url).digest('hex').slice(0, 12)}`,
    documentTitle: result.title,
    sourceType: 'web',
    documentMetadata: { sourceUri: result.url, collection: 'web-fallback' },
    index,
    label: `${result.title} / Web result / C${index + 1}`,
    heading: 'Web result',
    section: 'Web result',
    page: null,
    pageStart: null,
    pageEnd: null,
    pageNumbersExact: false,
    characterStart: null,
    characterEnd: null,
    text: result.text,
    tokenCount: tokenize(result.text, { keepStopwords: true }).length,
    terms,
    termCounts: {},
    embedding: [],
    embeddingProvider: 'web-search',
    embeddingModel: '',
    embeddingDimensions: 0
  };
  return {
    chunk,
    rank: index + 1,
    score: Number(score.toFixed(3)),
    rawScore: Number(score.toFixed(3)),
    lexicalScore: Number(coverage.toFixed(3)),
    vectorScore: 0,
    similarityScore: 0,
    rerankScore: Number(score.toFixed(3)),
    coverage: Number(coverage.toFixed(3)),
    novelty: 1,
    matchedTerms,
    missingTerms: queryTerms.filter((term) => !matchedTerms.includes(term)),
    contextRole: 'fallback',
    matchedChunkId: null
  };
}

function searchUrl(baseUrl, query) {
  if (!baseUrl) throw new Error('Web search base URL is not configured.');
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith('/search')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
  url.searchParams.set('q', String(query || ''));
  url.searchParams.set('format', 'json');
  return url.toString();
}

function safeResultUrl(value, knownSecrets) {
  try {
    const sanitized = redactSecrets(String(value || ''), knownSecrets);
    if (sanitized.findings.length) return '';
    const url = new URL(sanitized.text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function domainAllowed(value, allowedDomains = []) {
  if (!allowedDomains.length) return true;
  const hostname = new URL(value).hostname.toLowerCase();
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function normalizedScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0.45;
  return Number(Math.max(0, Math.min(1, score)).toFixed(3));
}

function cleanText(value) {
  return String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
