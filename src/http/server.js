import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeHostName } from '../config.js';
import { safeEndpointHost } from '../observability/otel.js';
import { httpError } from '../services/validation.js';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon']
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
const AUTH_FAILURE_LIMIT = 8;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_BACKOFF_MS = 2_000;
const authFailures = new Map();

export function createServer({ config, store }) {
  return http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, config, store });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, error.statusCode || 500, {
        error: error.message || 'Unexpected server error.'
      });
    }
  });
}

async function routeRequest({ request, response, config, store }) {
  requireAllowedHost(request, config);

  const url = new URL(request.url, 'http://raglens.local');

  if (url.pathname.startsWith('/api/')) {
    await routeApi({ request, response, url, config, store });
    return;
  }

  await serveStatic({ request, response, url, publicDir: config.publicDir });
}

async function routeApi({ request, response, url, config, store }) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      name: 'raglens'
    });
    return;
  }

  requireApiAuth(request, config);

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const state = store.snapshot();
    sendJson(response, 200, {
      ...state,
      providers: publicProviderState(config),
      storage: publicStorageState(config),
      observability: publicObservabilityState(config),
      parsers: publicParserState(config),
      runs: store.listRuns()
    });
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/settings') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 200, await store.updateSettings(body));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/projects') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 201, await store.addProject(body));
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/projects/active') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    const state = await store.setActiveProject(body.projectId);
    sendOptionalJson(response, state, 'Project not found.');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
    await requireMutation(request, config);
    sendJson(response, 200, await store.resetDemo());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/documents') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 201, await store.addDocument(body));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/documents/reindex') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 200, await store.reindexDocuments(body));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/ingestion-jobs') {
    sendJson(response, 200, store.listIngestionJobs(url.searchParams.get('projectId')));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/ingestion-jobs') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 202, store.queueDocument(body));
    return;
  }

  const ingestionJobMatch = url.pathname.match(/^\/api\/ingestion-jobs\/([^/]+)$/);
  if (request.method === 'GET' && ingestionJobMatch) {
    const job = store.getIngestionJob(ingestionJobMatch[1], url.searchParams.get('projectId'));
    sendOptionalJson(response, job, 'Ingestion job not found.');
    return;
  }

  const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (request.method === 'DELETE' && documentMatch) {
    await requireMutation(request, config);
    const deleted = await store.deleteDocument(documentMatch[1], {
      projectId: url.searchParams.get('projectId')
    });
    sendDeleteJson(response, deleted);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/query-runs') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 201, await store.runQuery(body));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/eval-questions') {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    sendJson(response, 201, await store.addEvalQuestion(body));
    return;
  }

  const evalQuestionMatch = url.pathname.match(/^\/api\/eval-questions\/([^/]+)$/);
  if (request.method === 'DELETE' && evalQuestionMatch) {
    await requireMutation(request, config);
    const deleted = await store.deleteEvalQuestion(evalQuestionMatch[1], {
      projectId: url.searchParams.get('projectId')
    });
    sendDeleteJson(response, deleted);
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/query-runs\/([^/]+)$/);
  if (request.method === 'GET' && runMatch) {
    const run = store.hydrateRun(runMatch[1], {
      projectId: url.searchParams.get('projectId')
    });
    sendOptionalJson(response, run, 'Run not found.');
    return;
  }

  const runFeedbackMatch = url.pathname.match(/^\/api\/query-runs\/([^/]+)\/feedback$/);
  if (request.method === 'POST' && runFeedbackMatch) {
    await requireMutation(request, config);
    const body = await readJsonBody(request);
    const feedback = await store.addFeedback(runFeedbackMatch[1], body);
    sendOptionalJson(response, feedback, 'Run not found.', 201);
    return;
  }

  const runOtelMatch = url.pathname.match(/^\/api\/query-runs\/([^/]+)\/otel$/);
  if (request.method === 'GET' && runOtelMatch) {
    const otel = store.exportOtelRun(runOtelMatch[1], {
      projectId: url.searchParams.get('projectId')
    });
    sendOptionalJson(response, otel, 'Run not found.');
    return;
  }

  const runBundleMatch = url.pathname.match(/^\/api\/query-runs\/([^/]+)\/bundle$/);
  if (request.method === 'GET' && runBundleMatch) {
    const bundle = store.exportRunBundle(runBundleMatch[1], {
      projectId: url.searchParams.get('projectId')
    });
    if (!bundle) {
      sendJson(response, 404, { error: 'Run not found.' });
      return;
    }
    sendJsonDownload(response, 200, bundle, `${safeDownloadName(runBundleMatch[1])}-bundle.json`);
    return;
  }

  const shareMatch = url.pathname.match(/^\/api\/share\/([^/]+)$/);
  if (request.method === 'GET' && shareMatch) {
    const run = store.hydrateRun(shareMatch[1], {
      projectId: url.searchParams.get('projectId')
    });
    sendOptionalJson(response, run, 'Shared run not found.');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/compare') {
    const comparison = store.compareRuns(url.searchParams.get('left'), url.searchParams.get('right'), {
      projectId: url.searchParams.get('projectId')
    });
    sendOptionalJson(response, comparison, 'Comparison runs not found.');
    return;
  }

  sendJson(response, 404, {
    error: 'Route not found.'
  });
}

async function serveStatic({ request, response, url, publicDir }) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  const absolutePath = resolvePublicPath(url.pathname, publicDir);

  if (!absolutePath) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }

  try {
    const content = await readFile(absolutePath);
    response.writeHead(200, withSecurityHeaders({
        'Content-Type': contentType(absolutePath),
        'Content-Length': content.length,
        'Cache-Control': 'no-store'
      }));

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' && shouldServeAppShell(absolutePath)) {
      const appShell = await readFile(path.join(publicDir, 'index.html'));
      response.writeHead(200, withSecurityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': appShell.length,
        'Cache-Control': 'no-store'
      }));
      response.end(appShell);
      return;
    }
    throw Object.assign(error, { statusCode: error.code === 'ENOENT' ? 404 : 500 });
  }
}

async function readJsonBody(request) {
  const contentTypeHeader = request.headers['content-type'] || '';
  if (!contentTypeHeader.toLowerCase().includes('application/json')) {
    throw httpError(415, 'Content-Type must be application/json.');
  }

  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_500_000) {
      throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 });
  }
}

async function requireMutation(request, config) {
  const contentTypeHeader = request.headers['content-type'] || '';
  if (!contentTypeHeader.toLowerCase().includes('application/json')) {
    throw httpError(415, 'Content-Type must be application/json.');
  }

  const origin = request.headers.origin;
  if (origin && !sameOrigin(origin, request.headers.host)) {
    throw httpError(403, 'Cross-origin mutations are not allowed.');
  }

  if (config.adminToken) {
    if (!hasValidAdminToken(request, config)) {
      throw httpError(401, 'Admin token required.');
    }
  }
}

function requireApiAuth(request, config) {
  if (!config.adminToken) {
    return;
  }

  const failureKey = authFailureKey(request);
  const failure = authFailures.get(failureKey);
  if (failure?.blockedUntil && failure.blockedUntil > Date.now()) {
    throw httpError(429, 'Too many failed admin token attempts. Try again shortly.');
  }

  if (!hasValidAdminToken(request, config)) {
    recordAuthFailure(failureKey);
    throw httpError(401, 'Admin token required.');
  }

  authFailures.delete(failureKey);
}

function requireAllowedHost(request, config) {
  const requestHost = normalizeHostName(headerValue(request.headers.host));
  if (!requestHost) {
    throw httpError(400, 'Host header is required.');
  }
  if (!allowedRequestHosts(config).has(requestHost)) {
    throw httpError(403, 'Host header is not allowed.');
  }
}

function allowedRequestHosts(config) {
  const hosts = new Set(
    (config.allowedHosts || [])
      .map((host) => normalizeHostName(host))
      .filter(Boolean)
  );

  if (!hosts.size) {
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      hosts.add(host);
    }
  }

  return hosts;
}

function hasValidAdminToken(request, config) {
  const auth = headerValue(request.headers.authorization);
  const headerToken = headerValue(request.headers['x-raglens-token']);
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  return [headerToken, bearer].some((token) => secureTokenEquals(token, config.adminToken));
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function secureTokenEquals(candidate, expected) {
  if (!candidate || !expected) {
    return false;
  }

  const candidateHash = createHash('sha256').update(String(candidate)).digest();
  const expectedHash = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function sameOrigin(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function authFailureKey(request) {
  return request.socket?.remoteAddress || 'unknown';
}

function recordAuthFailure(key) {
  const now = Date.now();
  const previous = authFailures.get(key);
  const count = previous && previous.expiresAt > now ? previous.count + 1 : 1;
  authFailures.set(key, {
    count,
    expiresAt: now + AUTH_FAILURE_WINDOW_MS,
    blockedUntil: count >= AUTH_FAILURE_LIMIT ? now + AUTH_BACKOFF_MS : 0
  });
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, withSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  }));
  response.end(payload);
}

function sendOptionalJson(response, value, notFoundMessage, statusCode = 200) {
  sendJson(response, value ? statusCode : 404, value || { error: notFoundMessage });
}

function sendDeleteJson(response, deleted) {
  sendJson(response, deleted ? 200 : 404, { deleted });
}

function sendJsonDownload(response, statusCode, body, filename) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, withSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  }));
  response.end(payload);
}

function safeDownloadName(value) {
  return String(value || 'raglens-run').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'raglens-run';
}

function resolvePublicPath(pathname, publicDir) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('\0')) {
    return null;
  }

  const requestedPath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  const publicRoot = path.resolve(publicDir);
  const absolutePath = path.resolve(publicRoot, requestedPath);
  const insideRoot = absolutePath === publicRoot || absolutePath.startsWith(`${publicRoot}${path.sep}`);

  return insideRoot ? absolutePath : null;
}

function withSecurityHeaders(headers = {}) {
  return {
    ...SECURITY_HEADERS,
    ...headers
  };
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function shouldServeAppShell(filePath) {
  return !path.extname(filePath);
}

export function publicUrl(config) {
  return pathToFileURL(path.join(config.publicDir, 'index.html')).href;
}

function publicProviderState(config) {
  return {
    local: {
      configured: true,
      model: 'local-extractive-v1'
    },
    openaiCompatible: {
      configured: Boolean(config.openaiCompatible?.configured),
      endpointHost: safeEndpointHost(config.openaiCompatible?.baseUrl || ''),
      defaultModel: config.openaiCompatible?.defaultModel || '',
      timeoutMs: config.openaiCompatible?.timeoutMs || 0
    },
    costRates: {
      configured: Boolean(config.costRates?.configured),
      inputUsdPer1MTokens: config.costRates?.inputUsdPer1MTokens || 0,
      outputUsdPer1MTokens: config.costRates?.outputUsdPer1MTokens || 0
    }
  };
}

function publicStorageState(config) {
  return {
    driver: config.storage?.driver || 'json',
    postgres: {
      configured: Boolean(config.postgres?.configured),
      poolMax: config.postgres?.poolMax || 0,
      sslEnabled: Boolean(config.postgres?.ssl)
    }
  };
}

function publicObservabilityState(config) {
  return {
    otlp: {
      configured: Boolean(config.otel?.configured),
      endpointHost: safeEndpointHost(config.otel?.endpoint || ''),
      serviceName: config.otel?.serviceName || 'raglens',
      timeoutMs: config.otel?.timeoutMs || 0,
      headerCount: Object.keys(config.otel?.headers || {}).length
    }
  };
}

function publicParserState(config) {
  return {
    pdf: {
      mode: config.pdfTextExtractor?.configured ? 'external-command-with-internal-fallback' : 'internal-fallback',
      externalConfigured: Boolean(config.pdfTextExtractor?.configured),
      timeoutMs: config.pdfTextExtractor?.timeoutMs || 0
    }
  };
}
