import { readFile } from 'node:fs/promises';

const expectedRoutes = [
  ['GET', '/api/health'],
  ['GET', '/api/state'],
  ['POST', '/api/projects'],
  ['PATCH', '/api/projects/active'],
  ['PATCH', '/api/settings'],
  ['POST', '/api/documents'],
  ['POST', '/api/documents/reindex'],
  ['GET', '/api/ingestion-jobs'],
  ['POST', '/api/ingestion-jobs'],
  ['GET', '/api/ingestion-jobs/{id}'],
  ['DELETE', '/api/documents/{id}'],
  ['POST', '/api/query-runs'],
  ['GET', '/api/query-runs/{id}'],
  ['POST', '/api/query-runs/{id}/feedback'],
  ['GET', '/api/query-runs/{id}/otel'],
  ['GET', '/api/query-runs/{id}/trace'],
  ['GET', '/api/query-runs/{id}/bundle'],
  ['GET', '/api/share/{id}'],
  ['GET', '/api/compare'],
  ['POST', '/api/eval-questions'],
  ['DELETE', '/api/eval-questions/{id}'],
  ['POST', '/api/demo/reset']
];
const expectedResponseSchemas = new Map([
  ['GET /api/state', 'WorkspaceState'],
  ['POST /api/projects', 'WorkspaceState'],
  ['PATCH /api/projects/active', 'WorkspaceState'],
  ['PATCH /api/settings', 'Settings'],
  ['POST /api/documents', 'DocumentCreateResult'],
  ['POST /api/documents/reindex', 'ReindexResult'],
  ['GET /api/ingestion-jobs', 'IngestionJobList'],
  ['POST /api/ingestion-jobs', 'IngestionJob'],
  ['GET /api/ingestion-jobs/{id}', 'IngestionJob'],
  ['POST /api/query-runs', 'HydratedRun'],
  ['GET /api/query-runs/{id}', 'HydratedRun'],
  ['POST /api/query-runs/{id}/feedback', 'Feedback'],
  ['GET /api/query-runs/{id}/otel', 'OtlpTrace'],
  ['GET /api/query-runs/{id}/trace', 'RagTraceV2'],
  ['GET /api/query-runs/{id}/bundle', 'RunBundle'],
  ['GET /api/share/{id}', 'HydratedRun'],
  ['GET /api/compare', 'CompareResult'],
  ['POST /api/eval-questions', 'EvalQuestion'],
  ['POST /api/demo/reset', 'WorkspaceState']
]);

const spec = JSON.parse(await readFile('docs/api/openapi.json', 'utf8'));
const server = await readFile('src/http/server.js', 'utf8');
const readme = await readFile('README.md', 'utf8');
const failures = [];

if (spec.openapi !== '3.1.0') {
  failures.push('OpenAPI spec must use version 3.1.0.');
}

for (const [method, path] of expectedRoutes) {
  const operation = spec.paths?.[path]?.[method.toLowerCase()];
  if (!operation) {
    failures.push(`OpenAPI spec is missing ${method} ${path}.`);
    continue;
  }

  if (path === '/api/health') {
    if (JSON.stringify(operation.security || []) !== '[]') {
      failures.push('GET /api/health must be explicitly unauthenticated.');
    }
  } else {
    const inheritedSecurity = spec.security || [];
    const operationSecurity = operation.security || inheritedSecurity;
    if (!operationSecurity.length) {
      failures.push(`${method} ${path} must document admin-token security.`);
    }
    if (!operation.responses?.['401']) {
      failures.push(`${method} ${path} must document 401 when admin token auth is enabled.`);
    }
  }

  if (['POST', 'PATCH'].includes(method) && !operation.requestBody && path !== '/api/demo/reset') {
    failures.push(`${method} ${path} must document a JSON request body.`);
  }

  const expectedSchema = expectedResponseSchemas.get(`${method} ${path}`);
  if (expectedSchema && responseSchemaName(operation.responses?.['200'] || operation.responses?.['201'] || operation.responses?.['202']) !== expectedSchema) {
    failures.push(`${method} ${path} must document a ${expectedSchema} response schema.`);
  }
}

const documentedRoutes = Object.entries(spec.paths || {}).flatMap(([path, methods]) =>
  Object.keys(methods).map((method) => [method.toUpperCase(), path])
);
for (const [method, path] of documentedRoutes) {
  if (!expectedRoutes.some(([expectedMethod, expectedPath]) => expectedMethod === method && expectedPath === path)) {
    failures.push(`OpenAPI spec documents an unknown route: ${method} ${path}.`);
  }
}

for (const [method, path] of expectedRoutes) {
  const readmePath = path
    .replaceAll('{id}', ':id')
    .replace('/api/compare', '/api/compare?left=:id&right=:id');
  if (path !== '/api/health' && !readme.includes(`${method} ${readmePath}`)) {
    failures.push(`README API surface is missing ${method} ${readmePath}.`);
  }
}

const routeNeedles = [
  "url.pathname === '/api/health'",
  "url.pathname === '/api/state'",
  "url.pathname === '/api/projects'",
  "url.pathname === '/api/projects/active'",
  "url.pathname === '/api/settings'",
  "url.pathname === '/api/demo/reset'",
  "url.pathname === '/api/documents'",
  "url.pathname === '/api/documents/reindex'",
  "url.pathname === '/api/ingestion-jobs'",
  "url.pathname === '/api/query-runs'",
  "url.pathname === '/api/eval-questions'",
  "/^\\/api\\/documents\\/([^/]+)$/",
  "/^\\/api\\/ingestion-jobs\\/([^/]+)$/",
  "/^\\/api\\/eval-questions\\/([^/]+)$/",
  "/^\\/api\\/query-runs\\/([^/]+)$/",
  "/^\\/api\\/query-runs\\/([^/]+)\\/feedback$/",
  "/^\\/api\\/query-runs\\/([^/]+)\\/otel$/",
  "/^\\/api\\/query-runs\\/([^/]+)\\/trace$/",
  "/^\\/api\\/query-runs\\/([^/]+)\\/bundle$/",
  "/^\\/api\\/share\\/([^/]+)$/",
  "url.pathname === '/api/compare'"
];

for (const needle of routeNeedles) {
  if (!server.includes(needle)) {
    failures.push(`Router no longer contains expected route marker: ${needle}`);
  }
}

const bundleSchema = spec.components?.schemas?.RunBundle;
if (bundleSchema?.properties?.schema?.const !== 'raglens.run-bundle.v1') {
  failures.push('RunBundle schema must pin schema to raglens.run-bundle.v1.');
}
const bundleRunSchemaText = JSON.stringify(bundleSchema?.properties?.run || {});
if (!bundleRunSchemaText.includes('Full prompt text is omitted') || !bundleRunSchemaText.includes('"not":{"required":["text"]}')) {
  failures.push('RunBundle run schema must document that full prompt text is omitted.');
}
if (!JSON.stringify(spec).includes('"not":{"required":["text"]}')) {
  failures.push('SourceDocumentMetadata schema must forbid full document text.');
}
if (!JSON.stringify(spec).includes('"not":{"required":["embedding"]}')) {
  failures.push('EvidenceChunk schema must forbid embedding vectors.');
}
const stateSchema = spec.components?.schemas?.WorkspaceState;
for (const required of ['providers', 'storage', 'observability', 'parsers']) {
  if (!stateSchema?.required?.includes(required)) {
    failures.push(`WorkspaceState schema must require ${required}.`);
  }
}
const providerSchemaText = JSON.stringify(spec.components?.schemas?.ProviderStatus || {});
if (!providerSchemaText.includes('"not":{"required":["baseUrl","apiKey"]}')) {
  failures.push('ProviderStatus schema must forbid raw provider baseUrl and apiKey.');
}
for (const provider of ['reranker', 'embedding', 'queryRewrite', 'webFallback']) {
  if (!spec.components?.schemas?.ProviderStatus?.required?.includes(provider)) {
    failures.push(`ProviderStatus schema must require ${provider} status.`);
  }
}
const queryInput = spec.components?.schemas?.QueryRunInput?.properties || {};
for (const field of ['candidateDepth', 'parentContext', 'parentContextMaxTokens', 'metadataFilter']) {
  if (!queryInput[field]) failures.push(`QueryRunInput must document ${field}.`);
}
if (!spec.components?.schemas?.DocumentInput?.properties?.metadata) {
  failures.push('DocumentInput must document allow-listed metadata.');
}
if (spec.components?.schemas?.MetadataFilter?.additionalProperties !== false) {
  failures.push('MetadataFilter must reject unknown fields.');
}
const storageSchemaText = JSON.stringify(spec.components?.schemas?.StorageStatus || {});
if (!storageSchemaText.includes('"not":{"required":["databaseUrl"]}')) {
  failures.push('StorageStatus schema must forbid databaseUrl.');
}
if (!spec.components?.parameters?.ProjectIdQuery) {
  failures.push('OpenAPI spec must document optional ProjectIdQuery for scoped concurrent clients.');
}
for (const schemaName of ['DocumentInput', 'QueryRunInput', 'SettingsInput', 'FeedbackInput', 'EvalQuestionInput']) {
  if (!spec.components?.schemas?.[schemaName]?.properties?.projectId) {
    failures.push(`${schemaName} must document optional projectId.`);
  }
}

if (failures.length) {
  console.error('API contract check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`API contract check passed (${expectedRoutes.length} routes).`);

function responseSchemaName(response) {
  const ref = response?.content?.['application/json']?.schema?.$ref;
  return ref ? ref.split('/').at(-1) : '';
}
