import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
const LOCAL_PROVIDER_HTTP_HOSTS = new Set([...DEFAULT_ALLOWED_HOSTS, 'host.docker.internal', 'gateway.docker.internal']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

export function loadConfig(env = process.env) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(rootDir, env.RAGLENS_DATA_DIR || './data');
  const host = env.RAGLENS_HOST || '127.0.0.1';
  const allowedHosts = normalizeAllowedHosts(env.RAGLENS_ALLOWED_HOSTS || '', host);
  const adminToken = env.RAGLENS_ADMIN_TOKEN || '';
  const storageDriver = normalizeStorageDriver(env.RAGLENS_STORAGE_DRIVER || 'json');
  const databaseUrl = env.RAGLENS_DATABASE_URL || '';
  const databasePoolMax = clampNumber(env.RAGLENS_DATABASE_POOL_MAX, 1, 30, 5);
  const databaseSsl = String(env.RAGLENS_DATABASE_SSL || 'false').toLowerCase() === 'true';
  const allowInsecureDatabaseSsl = String(env.RAGLENS_ALLOW_INSECURE_DATABASE_SSL || 'false').toLowerCase() === 'true';
  const allowUnsafePublicBind = String(env.RAGLENS_ALLOW_UNSAFE_PUBLIC_BIND || 'false').toLowerCase() === 'true';
  const allowUnsafeProviderHttp = String(env.RAGLENS_ALLOW_UNSAFE_PROVIDER_HTTP || 'false').toLowerCase() === 'true';
  const allowUnsafeOtelHttp = String(env.RAGLENS_ALLOW_UNSAFE_OTEL_HTTP || 'false').toLowerCase() === 'true';
  const openaiBaseUrl = normalizeProviderBaseUrl(env.RAGLENS_OPENAI_BASE_URL || 'https://api.openai.com/v1', {
    allowUnsafeHttp: allowUnsafeProviderHttp
  });
  const openaiApiKey = env.RAGLENS_OPENAI_API_KEY || '';
  const openaiRequiresApiKey = providerRequiresApiKey(openaiBaseUrl);
  const openaiDefaultModel = env.RAGLENS_OPENAI_MODEL || 'gpt-4.1-mini';
  const openaiTimeoutMs = clampNumber(env.RAGLENS_OPENAI_TIMEOUT_MS, 1_000, 120_000, 30_000);
  const rerankerProvider = normalizeChoice(env.RAGLENS_RERANKER_PROVIDER || 'local', ['local', 'http', 'colbert'], 'RAGLENS_RERANKER_PROVIDER');
  const rerankerBaseUrl = env.RAGLENS_RERANKER_BASE_URL
    ? normalizeProviderBaseUrl(env.RAGLENS_RERANKER_BASE_URL, { allowUnsafeHttp: allowUnsafeProviderHttp })
    : '';
  const rerankerApiKey = env.RAGLENS_RERANKER_API_KEY || '';
  const rerankerModel = env.RAGLENS_RERANKER_MODEL || 'raglens-heuristic-reranker-v1';
  const rerankerTimeoutMs = clampNumber(env.RAGLENS_RERANKER_TIMEOUT_MS, 1_000, 120_000, 30_000);
  const embeddingProvider = normalizeChoice(env.RAGLENS_EMBEDDING_PROVIDER || 'local', ['local', 'openai-compatible'], 'RAGLENS_EMBEDDING_PROVIDER');
  const embeddingBaseUrl = env.RAGLENS_EMBEDDING_BASE_URL
    ? normalizeProviderBaseUrl(env.RAGLENS_EMBEDDING_BASE_URL, { allowUnsafeHttp: allowUnsafeProviderHttp })
    : '';
  const embeddingApiKey = env.RAGLENS_EMBEDDING_API_KEY || '';
  const embeddingModel = env.RAGLENS_EMBEDDING_MODEL || (embeddingProvider === 'local' ? 'local-hash-embedding-v1' : '');
  const embeddingTimeoutMs = clampNumber(env.RAGLENS_EMBEDDING_TIMEOUT_MS, 1_000, 120_000, 30_000);
  const embeddingBatchSize = clampNumber(env.RAGLENS_EMBEDDING_BATCH_SIZE, 1, 256, 32);
  const allowRemoteEmbeddingEgress = String(env.RAGLENS_ALLOW_REMOTE_EMBEDDING_EGRESS || 'false').toLowerCase() === 'true';
  const queryRewriteProvider = normalizeChoice(env.RAGLENS_QUERY_REWRITE_PROVIDER || 'local', ['local', 'openai-compatible'], 'RAGLENS_QUERY_REWRITE_PROVIDER');
  const queryRewriteBaseUrl = queryRewriteProvider === 'openai-compatible'
    ? env.RAGLENS_QUERY_REWRITE_BASE_URL
      ? normalizeProviderBaseUrl(env.RAGLENS_QUERY_REWRITE_BASE_URL, { allowUnsafeHttp: allowUnsafeProviderHttp })
      : openaiBaseUrl
    : '';
  const queryRewriteApiKey = queryRewriteProvider === 'openai-compatible'
    ? env.RAGLENS_QUERY_REWRITE_API_KEY || openaiApiKey
    : '';
  const queryRewriteModel = env.RAGLENS_QUERY_REWRITE_MODEL || openaiDefaultModel;
  const queryRewriteTimeoutMs = clampNumber(env.RAGLENS_QUERY_REWRITE_TIMEOUT_MS, 1_000, 60_000, 15_000);
  const allowRemoteQueryEgress = String(env.RAGLENS_ALLOW_REMOTE_QUERY_EGRESS || 'false').toLowerCase() === 'true';
  const webFallbackEnabled = String(env.RAGLENS_WEB_FALLBACK_ENABLED || 'false').toLowerCase() === 'true';
  const webSearchBaseUrl = env.RAGLENS_WEB_SEARCH_BASE_URL
    ? normalizeProviderBaseUrl(env.RAGLENS_WEB_SEARCH_BASE_URL, { allowUnsafeHttp: allowUnsafeProviderHttp })
    : '';
  const webSearchApiKey = env.RAGLENS_WEB_SEARCH_API_KEY || '';
  const webSearchTimeoutMs = clampNumber(env.RAGLENS_WEB_SEARCH_TIMEOUT_MS, 1_000, 60_000, 10_000);
  const webSearchMaxResults = clampNumber(env.RAGLENS_WEB_SEARCH_MAX_RESULTS, 1, 10, 5);
  const webSearchAllowedDomains = parseCsvList(env.RAGLENS_WEB_SEARCH_ALLOWED_DOMAINS || '').map(normalizeHostName).filter(Boolean);
  const webMinConfidence = clampNumber(env.RAGLENS_WEB_FALLBACK_MIN_CONFIDENCE, 0, 1, 0.32);
  const allowRemoteWebQueryEgress = String(env.RAGLENS_ALLOW_REMOTE_WEB_QUERY_EGRESS || 'false').toLowerCase() === 'true';
  const inputUsdPer1MTokens = clampNumber(env.RAGLENS_COST_INPUT_USD_PER_1M, 0, 10_000, 0);
  const outputUsdPer1MTokens = clampNumber(env.RAGLENS_COST_OUTPUT_USD_PER_1M, 0, 10_000, 0);
  const otelEndpoint = normalizeOtelEndpoint(env.RAGLENS_OTEL_EXPORT_URL || '', {
    allowUnsafeHttp: allowUnsafeOtelHttp
  });
  const otelServiceName = env.RAGLENS_OTEL_SERVICE_NAME || 'raglens';
  const otelTimeoutMs = clampNumber(env.RAGLENS_OTEL_TIMEOUT_MS, 1_000, 60_000, 5_000);
  const otelHeaders = parseHeaders(env.RAGLENS_OTEL_HEADERS || '');
  const otelIncludeContent = String(env.RAGLENS_OTEL_INCLUDE_CONTENT || 'false').toLowerCase() === 'true';
  const pdfTextCommand = env.RAGLENS_PDF_TEXT_COMMAND || '';
  const pdfTextArgs = parseStringArray(env.RAGLENS_PDF_TEXT_ARGS || '', ['-layout', '{input}', '-']);
  const pdfTextTimeoutMs = clampNumber(env.RAGLENS_PDF_TEXT_TIMEOUT_MS, 1_000, 60_000, 10_000);

  if (!isLoopbackHost(host) && !adminToken && !allowUnsafePublicBind) {
    throw new Error(
      'RAGLens refuses to bind to a non-loopback host without RAGLENS_ADMIN_TOKEN. Set RAGLENS_ALLOW_UNSAFE_PUBLIC_BIND=true only for trusted private networks.'
    );
  }
  if (!isLoopbackHost(host) && adminToken && !isStrongAdminToken(adminToken)) {
    throw new Error('RAGLENS_ADMIN_TOKEN must be at least 32 characters when binding to a non-loopback host.');
  }
  if (storageDriver === 'postgres' && !databaseUrl) {
    throw new Error('RAGLENS_STORAGE_DRIVER=postgres requires RAGLENS_DATABASE_URL.');
  }
  if (storageDriver === 'postgres' && !databaseSsl && !isLocalDatabaseUrl(databaseUrl) && !allowInsecureDatabaseSsl) {
    throw new Error('Remote Postgres requires RAGLENS_DATABASE_SSL=true. Set RAGLENS_ALLOW_INSECURE_DATABASE_SSL=true only for an isolated trusted network.');
  }
  if (pdfTextCommand && !path.isAbsolute(pdfTextCommand)) {
    throw new Error('RAGLENS_PDF_TEXT_COMMAND must be an absolute path to a trusted local binary.');
  }
  if (rerankerProvider !== 'local' && !rerankerBaseUrl) {
    throw new Error('A non-local RAGLENS_RERANKER_PROVIDER requires RAGLENS_RERANKER_BASE_URL.');
  }
  if (rerankerProvider !== 'local' && providerRequiresApiKey(rerankerBaseUrl) && !rerankerApiKey) {
    throw new Error('A remote RAGLENS_RERANKER_BASE_URL requires RAGLENS_RERANKER_API_KEY.');
  }
  if (embeddingProvider === 'openai-compatible' && (!embeddingBaseUrl || !embeddingModel)) {
    throw new Error('RAGLENS_EMBEDDING_PROVIDER=openai-compatible requires RAGLENS_EMBEDDING_BASE_URL and RAGLENS_EMBEDDING_MODEL.');
  }
  if (embeddingProvider === 'openai-compatible' && providerRequiresApiKey(embeddingBaseUrl) && !embeddingApiKey) {
    throw new Error('A remote RAGLENS_EMBEDDING_BASE_URL requires RAGLENS_EMBEDDING_API_KEY.');
  }
  if (embeddingProvider === 'openai-compatible' && providerRequiresApiKey(embeddingBaseUrl) && !allowRemoteEmbeddingEgress) {
    throw new Error('Remote embedding requires RAGLENS_ALLOW_REMOTE_EMBEDDING_EGRESS=true because document text leaves the deployment.');
  }
  if (queryRewriteProvider === 'openai-compatible' && providerRequiresApiKey(queryRewriteBaseUrl) && !queryRewriteApiKey) {
    throw new Error('A remote query rewrite provider requires RAGLENS_QUERY_REWRITE_API_KEY or RAGLENS_OPENAI_API_KEY.');
  }
  if (queryRewriteProvider === 'openai-compatible' && providerRequiresApiKey(queryRewriteBaseUrl) && !allowRemoteQueryEgress) {
    throw new Error('Remote query rewriting requires RAGLENS_ALLOW_REMOTE_QUERY_EGRESS=true because user queries leave the deployment.');
  }
  if (webFallbackEnabled && !webSearchBaseUrl) {
    throw new Error('RAGLENS_WEB_FALLBACK_ENABLED=true requires RAGLENS_WEB_SEARCH_BASE_URL.');
  }
  if (webFallbackEnabled && providerRequiresApiKey(webSearchBaseUrl) && !allowRemoteWebQueryEgress) {
    throw new Error('Remote web search requires RAGLENS_ALLOW_REMOTE_WEB_QUERY_EGRESS=true because user queries leave the deployment.');
  }

  return {
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    dataFile: path.join(dataDir, 'raglens.json'),
    host,
    allowedHosts,
    port: Number(env.RAGLENS_PORT || 4177),
    autoSeed: String(env.RAGLENS_AUTO_SEED || 'true').toLowerCase() !== 'false',
    adminToken,
    storage: {
      driver: storageDriver
    },
    postgres: {
      configured: storageDriver === 'postgres',
      databaseUrl,
      poolMax: databasePoolMax,
      ssl: databaseSsl ? { rejectUnauthorized: !allowInsecureDatabaseSsl } : null
    },
    allowUnsafePublicBind,
    allowUnsafeProviderHttp,
    allowUnsafeOtelHttp,
    openaiCompatible: {
      baseUrl: openaiBaseUrl,
      apiKey: openaiApiKey,
      defaultModel: openaiDefaultModel,
      timeoutMs: openaiTimeoutMs,
      requiresApiKey: openaiRequiresApiKey,
      configured: Boolean(openaiApiKey || !openaiRequiresApiKey)
    },
    reranker: {
      provider: rerankerProvider,
      baseUrl: rerankerBaseUrl,
      apiKey: rerankerApiKey,
      model: rerankerModel,
      timeoutMs: rerankerTimeoutMs,
      configured: rerankerProvider === 'local' || Boolean(rerankerBaseUrl)
    },
    embedding: {
      provider: embeddingProvider,
      baseUrl: embeddingBaseUrl,
      apiKey: embeddingApiKey,
      model: embeddingModel,
      timeoutMs: embeddingTimeoutMs,
      batchSize: embeddingBatchSize,
      remoteEgressAllowed: allowRemoteEmbeddingEgress,
      configured: embeddingProvider === 'local' || Boolean(embeddingBaseUrl && embeddingModel)
    },
    queryRewrite: {
      provider: queryRewriteProvider,
      baseUrl: queryRewriteBaseUrl,
      apiKey: queryRewriteApiKey,
      model: queryRewriteModel,
      timeoutMs: queryRewriteTimeoutMs,
      remoteEgressAllowed: allowRemoteQueryEgress,
      configured: queryRewriteProvider === 'local' || Boolean(queryRewriteBaseUrl && queryRewriteModel)
    },
    webFallback: {
      enabled: webFallbackEnabled,
      baseUrl: webSearchBaseUrl,
      apiKey: webSearchApiKey,
      timeoutMs: webSearchTimeoutMs,
      maxResults: webSearchMaxResults,
      allowedDomains: webSearchAllowedDomains,
      minConfidence: webMinConfidence,
      remoteEgressAllowed: allowRemoteWebQueryEgress
    },
    costRates: {
      inputUsdPer1MTokens,
      outputUsdPer1MTokens,
      configured: inputUsdPer1MTokens > 0 || outputUsdPer1MTokens > 0
    },
    otel: {
      endpoint: otelEndpoint,
      serviceName: otelServiceName,
      timeoutMs: otelTimeoutMs,
      headers: otelHeaders,
      includeContent: otelIncludeContent,
      configured: Boolean(otelEndpoint)
    },
    pdfTextExtractor: {
      command: pdfTextCommand,
      args: pdfTextArgs,
      timeoutMs: pdfTextTimeoutMs,
      configured: Boolean(pdfTextCommand)
    }
  };
}

function isLoopbackHost(host) {
  return DEFAULT_ALLOWED_HOSTS.includes(normalizeHostName(host));
}

function isStrongAdminToken(value) {
  const token = String(value || '');
  return token.length >= 32 && !/^(?:change-?me|dev-?token|test-?token)$/i.test(token);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeAllowedHosts(value, bindHost) {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  const configuredHost = normalizeHostName(bindHost);

  if (configuredHost && !WILDCARD_HOSTS.has(configuredHost)) {
    hosts.add(configuredHost);
  }

  for (const host of parseCsvList(value)) {
    const normalized = normalizeHostName(host);
    if (normalized) {
      hosts.add(normalized);
    }
  }

  return [...hosts];
}

export function normalizeHostName(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw) {
    return '';
  }

  const urlish = raw.includes('://') ? raw : `http://${hostForUrl(raw)}`;
  try {
    return stripHostBrackets(new URL(urlish).hostname);
  } catch {
    return '';
  }
}

function hostForUrl(value) {
  if (value.startsWith('[')) {
    return value;
  }

  return (value.match(/:/g) || []).length > 1 ? `[${value}]` : value;
}

function stripHostBrackets(value) {
  return String(value || '').replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseHeaders(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)])
      );
    }
  } catch {
    return {};
  }

  return {};
}

function parseStringArray(value, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function normalizeProviderBaseUrl(value, options = {}) {
  const raw = String(value || '').trim();

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
    if (url.protocol === 'http:' && !isLocalProviderHost(url.hostname) && !options.allowUnsafeHttp) {
      throw new Error('unsafe provider transport');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('unsafe URL components');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('RAGLENS_OPENAI_BASE_URL must be an HTTPS URL without credentials, query strings, or fragments. HTTP is allowed only for loopback or Docker host aliases unless RAGLENS_ALLOW_UNSAFE_PROVIDER_HTTP=true.');
  }
}

function providerRequiresApiKey(baseUrl) {
  try {
    return !isLocalProviderHost(new URL(baseUrl).hostname);
  } catch {
    return true;
  }
}

function isLocalProviderHost(host) {
  return LOCAL_PROVIDER_HTTP_HOSTS.has(normalizeHostName(host));
}

function normalizeOtelEndpoint(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !options.allowUnsafeHttp) {
      throw new Error('unsafe OTLP transport');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('unsafe OTLP URL components');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('RAGLENS_OTEL_EXPORT_URL must be an HTTPS URL without credentials, query strings, or fragments. HTTP is allowed only for loopback hosts unless RAGLENS_ALLOW_UNSAFE_OTEL_HTTP=true.');
  }
}

function normalizeStorageDriver(value) {
  const driver = String(value || 'json').trim().toLowerCase();
  if (!['json', 'postgres'].includes(driver)) {
    throw new Error('RAGLENS_STORAGE_DRIVER must be "json" or "postgres".');
  }
  return driver;
}

function isLocalDatabaseUrl(value) {
  try {
    return DEFAULT_ALLOWED_HOSTS.includes(normalizeHostName(new URL(value).hostname));
  } catch {
    return false;
  }
}

function normalizeChoice(value, choices, name) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!choices.includes(normalized)) {
    throw new Error(`${name} must be one of: ${choices.join(', ')}.`);
  }
  return normalized;
}
