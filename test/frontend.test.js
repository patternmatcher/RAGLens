import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser API client can send the admin token header for secured deployments', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /const ADMIN_TOKEN_KEY = 'raglens\.adminToken'/);
  assert.match(app, /sessionStorage\.getItem\(ADMIN_TOKEN_KEY\)/);
  assert.match(app, /'X-RAGLens-Token': token/);
  assert.match(app, /sessionStorage\.setItem\(ADMIN_TOKEN_KEY/);
});

test('inspector renders a claim-by-source usage matrix', async () => {
  const [app, styles] = await Promise.all([
    readFile('public/app.js', 'utf8'),
    readFile('public/styles.css', 'utf8')
  ]);

  assert.match(app, /function renderSourceUsageMatrix\(run\)/);
  assert.match(app, /Claim support mapped to retrieved chunks/);
  assert.match(app, /function renderSourceUsageCell\(claim, source\)/);
  assert.match(app, /function sourceSupportForClaim\(claim, chunkId\)/);
  assert.match(app, /support from this source/);
  assert.match(styles, /\.source-matrix/);
  assert.match(styles, /\.source-cell\.supported::before/);
  assert.match(styles, /\.source-cell\.best-match/);
});

test('usage panel renders cost basis and small-dollar estimates', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /function formatUsd\(value\)/);
  assert.match(app, /Cost basis/);
  assert.match(app, /usage\.cost\.inputUsd/);
  assert.match(app, /number\.toFixed\(6\)/);
});

test('eval set screen includes editable regression checks', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /id="eval-form"/);
  assert.match(app, /Save Eval Check/);
  assert.match(app, /Save an eval check to run regression questions/);
  assert.match(app, /Save an eval check before running the set/);
  assert.match(app, /data-delete-eval/);
  assert.match(app, /async function submitEvalQuestion/);
  assert.match(app, /\/api\/eval-questions/);
});

test('topbar exposes project creation and switching controls', async () => {
  const [html, app] = await Promise.all([
    readFile('public/index.html', 'utf8'),
    readFile('public/app.js', 'utf8')
  ]);

  assert.match(html, /id="project-select"/);
  assert.match(html, /id="new-project-button"/);
  assert.match(app, /async function createProject/);
  assert.match(app, /async function switchProject/);
  assert.match(app, /\/api\/state\?projectId=/);
  assert.doesNotMatch(app, /\/api\/projects\/active/);
});

test('browser client pins scoped mutations to the selected project', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /function currentProjectId\(\)/);
  assert.match(app, /function withProjectBody\(body = \{\}\)/);
  assert.match(app, /function withProjectParam\(path\)/);
  assert.match(app, /projectId: currentProjectId\(\)/);
  assert.match(app, /withProjectParam\(`\/api\/compare\?left=\$\{left\.value\}&right=\$\{right\.value\}`\)/);
  assert.match(app, /withProjectParam\(`\/api\/query-runs\/\$\{runId\}\/bundle`\)/);
});

test('documents screen exposes queued ingestion workflow', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /id="queue-document-button"/);
  assert.match(app, /id="reindex-documents-button"/);
  assert.match(app, /function renderIngestionJobs/);
  assert.match(app, /async function submitQueuedDocument/);
  assert.match(app, /async function reindexDocuments/);
  assert.match(app, /\/api\/ingestion-jobs/);
  assert.match(app, /\/api\/documents\/reindex/);
  assert.match(app, /function scheduleIngestionRefresh/);
  assert.match(app, /form\?\.reportValidity\(\)/);
  assert.match(app, /runSafely\(\(\) => submitQueuedDocument\(payload\)\)/);
});

test('document file picker mirrors server-side upload limits before reading files', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /const DOCUMENT_TEXT_CHAR_LIMIT = 200_000/);
  assert.match(app, /const TEXT_FILE_BYTE_LIMIT = 260_000/);
  assert.match(app, /const PDF_FILE_BYTE_LIMIT = 1_000_000/);
  assert.match(app, /assertFileWithinLimit\(file, PDF_FILE_BYTE_LIMIT, 'PDF'\)/);
  assert.match(app, /assertFileWithinLimit\(file, TEXT_FILE_BYTE_LIMIT, 'Text file'\)/);
  assert.match(app, /function bytesToBase64\(bytes\)/);
  assert.match(app, /function resetSelectedFile\(input\)/);
});

test('settings and usage panels expose OTLP export status', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /OTLP export/);
  assert.match(app, /otlpState\.endpointHost/);
  assert.match(app, /runOrUsage\.observability\?\.otelExport/);
  assert.match(app, /PDF parser/);
  assert.match(app, /state\.data\.parsers\?\.pdf/);
  assert.match(app, /Storage/);
  assert.match(app, /state\.data\.storage/);
});

test('inspector can download a portable run bundle', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /data-download-bundle/);
  assert.match(app, /Run Bundle/);
  assert.match(app, /async function downloadRunBundle/);
  assert.match(app, /\/api\/query-runs\/\$\{runId\}\/bundle/);
  assert.match(app, /\$\{runId\}-bundle\.json/);
});

test('share links and compare labels handle reviewer edge cases', async () => {
  const app = await readFile('public/app.js', 'utf8');

  assert.match(app, /function formatRunOption\(run\)/);
  assert.match(app, /config\.retrievalMode/);
  assert.match(app, /config\.topK/);
  assert.match(app, /async function copyTextToClipboard/);
  assert.match(app, /document\.execCommand\?\.\('copy'\)/);
  assert.match(app, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.match(app, /Shared run was not found/);
});

test('compare screen renders config, answer, retrieval, and warning deltas', async () => {
  const [app, styles] = await Promise.all([
    readFile('public/app.js', 'utf8'),
    readFile('public/styles.css', 'utf8')
  ]);

  assert.match(app, /Comparison Summary/);
  assert.match(app, /function renderConfigDiffs/);
  assert.match(app, /function renderAnswerComparison/);
  assert.match(app, /function renderRetrievalComparison/);
  assert.match(app, /function renderStableSources/);
  assert.match(app, /Source Overlap/);
  assert.match(app, /Stable Sources/);
  assert.match(app, /function renderWarningComparison/);
  assert.match(app, /Retrieval Movement/);
  assert.match(styles, /\.retrieval-diff-grid/);
  assert.match(styles, /\.answer-compare/);
  assert.match(styles, /\.mini-chunk/);
});

test('mobile topbar stacks project controls without page-level overflow', async () => {
  const styles = await readFile('public/styles.css', 'utf8');

  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.sidebar \{[\s\S]*?grid-template-columns: 1fr/);
  assert.match(styles, /\.brand-block,[\s\S]*?\.nav-list[\s\S]*?width: 100%/);
  assert.match(styles, /\.topbar-actions,[\s\S]*?\.project-switcher[\s\S]*?width: 100%/);
  assert.match(styles, /\.topbar-actions \{[\s\S]*?flex-direction: column/);
  assert.match(styles, /\.topbar-actions button,[\s\S]*?\.topbar-actions select[\s\S]*?width: 100%/);
});

test('UI exposes active states and transient notices to assistive technology', async () => {
  const [html, app, styles] = await Promise.all([
    readFile('public/index.html', 'utf8'),
    readFile('public/app.js', 'utf8'),
    readFile('public/styles.css', 'utf8')
  ]);

  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(app, /aria-current', 'page'/);
  assert.match(app, /aria-current="true"/);
  assert.match(app, /function heatmapSummary/);
  assert.match(app, /role="img" aria-label/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /\.sr-only/);
  assert.match(styles, /color: var\(--ink\)/);
});
