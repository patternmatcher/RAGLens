import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { inspectChunksForRisks, inspectChunksForSensitiveData } from '../src/rag/evaluator.js';
import { buildOtlpPayload, exportOtlpTrace } from '../src/observability/otel.js';
import { runRagInspection } from '../src/rag/pipeline.js';
import { rewriteQuery } from '../src/rag/query.js';
import { retrieve } from '../src/rag/retriever.js';

const options = parseArgs(process.argv.slice(2));
validateOptions(options);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const traceLensDir = path.resolve(rootDir, options.traceLensDir);
const outputDir = path.resolve(rootDir, options.outputDir);
const traceLensCli = path.join(traceLensDir, 'src', 'cli.js');
await access(traceLensCli).catch(() => {
  throw new Error(`TraceLens was not found at ${traceLensDir}. Pass --tracelens-dir=<path>.`);
});
await mkdir(outputDir, { recursive: true });

const hostedAuth = await import(pathToFileURL(path.join(traceLensDir, 'src', 'shared', 'hosted-auth.js')));
const hostedCollector = await import(pathToFileURL(path.join(traceLensDir, 'src', 'shared', 'hosted-collector.js')));
const queueModule = await import(pathToFileURL(path.join(traceLensDir, 'src', 'shared', 'durable-queue.js')));
const objectStoreModule = await import(pathToFileURL(path.join(traceLensDir, 'src', 'shared', 'object-store.js')));
const traceCore = await import(pathToFileURL(path.join(traceLensDir, 'src', 'shared', 'trace-core.js')));

const providerHeaders = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
const health = await fetchJson(`${options.baseUrl.replace(/\/v1\/?$/, '')}/health`, providerHeaders);
const models = await fetchJson(`${options.baseUrl.replace(/\/+$/, '')}/models`, providerHeaders);
if (!health.ok) throw new Error('The local vLLM bridge is not healthy.');
if (!(models.data || []).some((item) => item.id === options.model)) {
  throw new Error(`The local provider did not advertise model ${options.model}.`);
}

const corpus = JSON.parse(await readFile(path.join(rootDir, 'corpora', 'normalized', `${options.corpus}.json`), 'utf8'));
const workload = prepareWorkload(corpus, options);
const gpuBefore = options.gpuSnapshots ? readGpuSnapshot() : null;
const collectorScope = { organizationId: 'org-local-validation', projectId: 'raglens-open-weight' };
const issued = hostedAuth.issueHostedApiKey({
  ...collectorScope,
  subjectId: 'raglens-open-weight-eval',
  role: 'ingestor',
  scopes: ['artifact:write']
});
const objectStore = new objectStoreModule.FileObjectStore({ rootDir: path.join(outputDir, 'collector', 'objects') });
const queue = new queueModule.DurableArtifactQueue({
  dir: path.join(outputDir, 'collector', 'queue'),
  maxPendingItems: 100
});
const collector = await hostedCollector.startHostedOtlpCollector({
  host: '127.0.0.1',
  port: 0,
  apiKeyRecords: [issued.record],
  objectStore,
  queue,
  auditFile: path.join(outputDir, 'collector', 'audit.jsonl'),
  rateLimitPerMinute: 10
});

let run;
let exportStatus;
let normalizedTrace;
try {
  const inspected = await runRagInspection({
    question: workload.question.question,
    chunks: workload.chunks,
    config: {
      topK: options.topK,
      maxClaims: 4,
      maxOutputTokens: options.maxOutputTokens,
      chunkTokens: options.chunkTokens,
      overlapTokens: options.overlapTokens,
      retrievalMode: 'hybrid',
      rerank: true,
      provider: 'openai-compatible',
      model: options.model,
      temperature: 0,
      promptLoggingEnabled: false,
      expectedSource: workload.question.expectedSources?.[0] || '',
      expectedSources: workload.question.expectedSources || [],
      expectedAnswer: workload.question.expectedAnswer || '',
      openaiCompatible: {
        configured: true,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        timeoutMs: options.providerTimeoutMs
      },
      costRates: { configured: false }
    }
  });
  if (inspected.config.mode !== 'openai-compatible-chat') {
    const providerWarning = inspected.warnings.find((warning) => warning.type === 'provider-error');
    throw new Error(`RAGLens did not use the live provider. ${providerWarning?.message || 'No provider error was recorded.'}`);
  }
  run = hydrateRun({
    ...inspected,
    id: `run_${randomUUID().replace(/-/g, '')}`,
    projectId: collectorScope.projectId
  }, workload);

  exportStatus = await exportOtlpTrace(run, {
    endpoint: `${collector.url}/v1/traces`,
    timeoutMs: 30_000,
    includeContent: false,
    serviceName: 'raglens-open-weight-eval',
    environment: 'local-gpu',
    headers: {
      Authorization: `Bearer ${issued.token}`,
      'X-TraceLens-Organization': collectorScope.organizationId,
      'X-TraceLens-Project': collectorScope.projectId
    }
  });
  if (!exportStatus.ok) throw new Error(`TraceLens collector export failed: ${exportStatus.error}`);

  const [item] = queue.snapshot().items;
  if (!item?.payload?.object) throw new Error('TraceLens collector did not queue the exported trace.');
  normalizedTrace = await objectStore.getJson(item.payload.object, { ...collectorScope, kind: 'trace' });
} finally {
  await new Promise((resolve) => collector.server.close(resolve));
}

const metricsText = await fetchText(
  `${options.baseUrl.replace(/\/v1\/?$/, '')}/metrics`,
  providerHeaders
);
const bridgeMetrics = parseMetrics(metricsText);
const gpuAfter = options.gpuSnapshots ? readGpuSnapshot() : null;
normalizedTrace.modelServing = {
  ...(normalizedTrace.modelServing || {}),
  provider: 'vllm',
  model: options.model,
  quantization: 'bitsandbytes',
  contextWindow: 2048,
  maxModelLen: 2048,
  decodeTimeMs: round(bridgeMetrics.generationSeconds * 1000),
  requestLatencyMs: round(bridgeMetrics.generationSeconds * 1000),
  tokensPerSecond: round(bridgeMetrics.tokensPerSecond),
  gpuMemoryUtilization: gpuAfter ? round(gpuAfter.memoryUsedMiB / gpuAfter.memoryTotalMiB) : 0
};
const traceValidation = traceCore.validateTrace(normalizedTrace);
if (!traceValidation.ok) throw new Error(`TraceLens normalization failed: ${traceValidation.errors[0]}`);

const files = {
  run: path.join(outputDir, 'raglens-run.json'),
  otlp: path.join(outputDir, 'raglens-otlp.json'),
  trace: path.join(outputDir, 'tracelens-trace.json'),
  gate: path.join(outputDir, 'tracelens-gate.json'),
  evidence: path.join(outputDir, 'tracelens-evidence.json'),
  evidenceMarkdown: path.join(outputDir, 'tracelens-evidence.md'),
  metrics: path.join(outputDir, 'vllm-metrics.prom'),
  result: path.join(outputDir, 'result.json')
};
await writeJson(files.run, run);
await writeJson(files.otlp, buildOtlpPayload(run, {
  includeContent: false,
  serviceName: 'raglens-open-weight-eval',
  environment: 'local-gpu'
}));
await writeJson(files.trace, normalizedTrace);
await writeFile(files.metrics, metricsText, 'utf8');

const policyFile = path.join(traceLensDir, 'policies', 'raglens-local-demo.json');
const gateProcess = await runCommand(process.execPath, [
  traceLensCli, 'gate', files.trace, '--policy', policyFile, '--out', files.gate
], traceLensDir);
if (![0, 1].includes(gateProcess.status)) {
  throw new Error(`TraceLens gate failed to run: ${gateProcess.stderr || gateProcess.stdout}`);
}
const evidenceProcess = await runCommand(process.execPath, [
  traceLensCli, 'evidence-report', files.trace, '--out', files.evidence,
  '--markdown', files.evidenceMarkdown, '--allow-evidence-gaps'
], traceLensDir);
if (evidenceProcess.status !== 0) {
  throw new Error(`TraceLens evidence report failed: ${evidenceProcess.stderr || evidenceProcess.stdout}`);
}

const gate = await readJson(files.gate);
const evidence = await readJson(files.evidence);
const result = {
  schemaVersion: 'raglens-open-weight-stack-validation/v1',
  generatedAt: new Date().toISOString(),
  workload: {
    corpus: corpus.name,
    sourceUrl: corpus.sourceUrl,
    documents: workload.documents.length,
    chunks: workload.chunks.length,
    questionId: String(workload.question.id),
    question: workload.question.question,
    expectedSources: workload.question.expectedSources || [],
    expectedAnswerAvailable: Boolean(workload.question.expectedAnswer)
  },
  runtime: {
    model: options.model,
    provider: 'vllm',
    quantization: 'bitsandbytes',
    maxModelLen: 2048,
    outputTokenLimit: options.maxOutputTokens,
    bridgeHealth: health,
    advertisedModels: (models.data || []).map((item) => item.id),
    gpuBefore,
    gpuAfter,
    bridgeMetrics
  },
  raglens: {
    mode: run.config.mode,
    answer: run.answer.text,
    citations: run.answer.citations.length,
    warnings: run.warnings.map((warning) => warning.type),
    metrics: run.evaluation.metrics,
    usage: run.usage,
    latencyMs: run.latencyMs
  },
  tracelens: {
    export: exportStatus,
    traceId: normalizedTrace.traceId,
    steps: normalizedTrace.steps.length,
    evidence: normalizedTrace.evidence.length,
    claims: normalizedTrace.answer.claims.length,
    gatePass: gate.pass,
    gateExitCode: gateProcess.status,
    failedChecks: gate.traces?.[0]?.checks?.filter((check) => !check.pass).map((check) => check.id) || [],
    evidenceReportPass: evidence.pass
  },
  limitations: [
    'This is one local-model generation, not a throughput benchmark.',
    'Cold-start time includes model loading from a Windows-mounted 9P filesystem.',
    'OTLP content export stayed redacted; the local RAGLens result retains the answer for review.'
  ]
};
await writeJson(files.result, result);
if (options.report) await writeFile(path.resolve(rootDir, options.report), renderReport(result), 'utf8');

console.log(`Open-weight stack validation complete: ${files.result}`);
console.log(`TraceLens gate: ${gate.pass ? 'PASS' : 'FAIL'} (${result.tracelens.failedChecks.join(', ') || 'no failed checks'})`);

function prepareWorkload(corpus, config) {
  const documents = corpus.documents.map((document) => createDocument({
    title: document.title,
    sourceType: document.sourceType || 'text',
    text: document.text,
    metadata: document.metadata || {},
    projectId: corpus.key
  }));
  const chunks = documents.flatMap((document) => chunkDocument(document, {
    maxTokens: config.chunkTokens,
    overlapTokens: config.overlapTokens
  }));
  const titles = new Set(documents.map((document) => document.title));
  const candidates = corpus.questions.filter((question) =>
    (question.expectedSources || []).some((source) => titles.has(source))
    && (!config.questionId || String(question.id) === config.questionId)
  );
  const question = candidates.find((candidate) => safeRetrieval(candidate, chunks, config.topK));
  if (!question) throw new Error('No safe corpus question matched the requested workload.');
  return { documents, chunks, question };
}

function safeRetrieval(question, chunks, topK) {
  const query = rewriteQuery(question.question);
  const results = retrieve(query.rewritten || question.question, chunks, {
    topK,
    retrievalMode: 'hybrid',
    rerank: true
  }).results;
  const selected = results.map((item) => item.chunk);
  return inspectChunksForRisks(selected).length === 0 && inspectChunksForSensitiveData(selected).length === 0;
}

function hydrateRun(run, workload) {
  const chunks = new Map(workload.chunks.map((chunk) => [chunk.id, chunk]));
  const documents = new Map(workload.documents.map((document) => [document.id, document]));
  return {
    ...run,
    retrieved: run.retrieved.map((item) => {
      const chunk = chunks.get(item.chunkId);
      const document = documents.get(chunk?.documentId);
      return {
        ...item,
        chunk,
        document: document ? {
          id: document.id,
          title: document.title,
          checksum: document.checksum,
          sourceType: document.sourceType
        } : null
      };
    })
  };
}

function parseMetrics(text) {
  const values = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
    if (match) values.set(match[1], Number(match[2]));
  }
  const outputTokens = values.get('raglens_vllm_bridge_output_tokens_total')
    || values.get('vllm_generation_tokens_total')
    || 0;
  const tokensPerSecond = values.get('raglens_vllm_bridge_tokens_per_second') || 0;
  const generationSeconds = values.get('vllm_request_decode_time_seconds')
    || (tokensPerSecond ? outputTokens / tokensPerSecond : 0);
  return {
    requests: values.get('raglens_vllm_bridge_requests_total') || 0,
    failures: values.get('raglens_vllm_bridge_failures_total') || 0,
    inputTokens: values.get('vllm_prompt_tokens_total') || 0,
    outputTokens,
    tokensPerSecond,
    loadSeconds: values.get('raglens_vllm_bridge_load_seconds') || 0,
    generationSeconds
  };
}

function readGpuSnapshot() {
  const args = [
    '--query-gpu=name,driver_version,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits'
  ];
  const result = spawnSync('nvidia-smi', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    killSignal: 'SIGTERM'
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const [name, driverVersion, memoryUsedMiB, memoryTotalMiB, utilizationPercent, temperatureC, powerWatts] =
    result.stdout.trim().split(',').map((value) => value.trim());
  return {
    name,
    driverVersion,
    memoryUsedMiB: Number(memoryUsedMiB),
    memoryTotalMiB: Number(memoryTotalMiB),
    utilizationPercent: Number(utilizationPercent),
    temperatureC: Number(temperatureC),
    powerWatts: Number(powerWatts)
  };
}

function renderReport(result) {
  const gateResult = result.tracelens.gatePass ? 'PASS' : 'FAIL';
  const answer = cleanText(result.raglens.answer).split(/\r?\n/).map((line) => `> ${line}`).join('\n');
  return `# Open-Weight Stack Validation

Run date: ${result.generatedAt}

This run used the local ${result.runtime.model} model through vLLM, queried a real external corpus in RAGLens, exported redacted OTLP through the authenticated TraceLens collector, and applied the TraceLens release gate.

## Workload

- Corpus: ${result.workload.corpus}
- Documents: ${result.workload.documents}
- Chunks: ${result.workload.chunks}
- Question id: ${result.workload.questionId}
- Question: ${cleanText(result.workload.question)}
- Expected sources: ${result.workload.expectedSources.map(cleanText).join(', ')}

## Measured Result

- RAGLens mode: ${result.raglens.mode}
- Retrieval recall@k: ${format(result.raglens.metrics.recallAtK)}
- Expected source recall@k: ${format(result.raglens.metrics.sourceRecallAtK)}
- Faithfulness: ${format(result.raglens.metrics.faithfulness)}
- Citation coverage: ${format(result.raglens.metrics.citationCoverage)}
- End-to-end latency: ${format(result.raglens.latencyMs / 1000)} seconds
- Provider generation: ${format(result.runtime.bridgeMetrics.generationSeconds)} seconds
- Output tokens: ${result.raglens.usage.outputTokens}
- Measured output rate: ${format(result.runtime.bridgeMetrics.tokensPerSecond)} tokens per second
- GPU memory after generation: ${result.runtime.gpuAfter ? `${result.runtime.gpuAfter.memoryUsedMiB} / ${result.runtime.gpuAfter.memoryTotalMiB} MiB` : 'not available'}

## Model Answer

${answer}

## TraceLens Result

- OTLP collector export: ${result.tracelens.export.ok ? 'accepted' : 'rejected'}
- Normalized trace steps: ${result.tracelens.steps}
- Evidence items: ${result.tracelens.evidence}
- Claims: ${result.tracelens.claims}
- Release gate: ${gateResult}
- Failed checks: ${result.tracelens.failedChecks.join(', ') || 'none'}

## Scope

This is a functional integration result from one local-model generation. It proves the model, retrieval, OTLP ingestion, normalization, evidence report, and release gate can operate together. It is not a concurrency or throughput benchmark. The model loaded from a Windows-mounted 9P filesystem, so cold-start and generation timing should not be treated as native Linux serving performance.
`;
}

function parseArgs(args) {
  const options = {
    traceLensDir: '../tracelens',
    outputDir: 'corpora/results/open-weight-stack',
    report: 'corpora/results/open-weight-stack/README.md',
    corpus: 'stratrag',
    questionId: '',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'Llama-3.1-8B-Instruct',
    topK: 4,
    chunkTokens: 120,
    overlapTokens: 24,
    maxOutputTokens: 64,
    providerTimeoutMs: 1_200_000,
    gpuSnapshots: true,
    apiKey: process.env.VLLM_API_KEY || process.env.RAGLENS_OPENAI_API_KEY || ''
  };
  for (const arg of args) {
    if (arg.startsWith('--tracelens-dir=')) options.traceLensDir = arg.slice('--tracelens-dir='.length);
    else if (arg.startsWith('--out-dir=')) options.outputDir = arg.slice('--out-dir='.length);
    else if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length);
    else if (arg === '--no-report') options.report = '';
    else if (arg.startsWith('--corpus=')) options.corpus = arg.slice('--corpus='.length);
    else if (arg.startsWith('--question-id=')) options.questionId = arg.slice('--question-id='.length);
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length);
    else if (arg.startsWith('--top-k=')) options.topK = positiveInteger(arg, '--top-k=', options.topK);
    else if (arg.startsWith('--chunk-tokens=')) options.chunkTokens = positiveInteger(arg, '--chunk-tokens=', options.chunkTokens);
    else if (arg.startsWith('--overlap-tokens=')) options.overlapTokens = positiveInteger(arg, '--overlap-tokens=', options.overlapTokens);
    else if (arg.startsWith('--max-output-tokens=')) options.maxOutputTokens = positiveInteger(arg, '--max-output-tokens=', options.maxOutputTokens);
    else if (arg.startsWith('--provider-timeout-ms=')) options.providerTimeoutMs = positiveInteger(arg, '--provider-timeout-ms=', options.providerTimeoutMs);
    else if (arg === '--skip-gpu-snapshot') options.gpuSnapshots = false;
  }
  return options;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.text();
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function positiveInteger(arg, prefix, fallback) {
  const value = Number(arg.slice(prefix.length));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validateOptions(config) {
  let url;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error('--base-url must be a valid local URL.');
  }
  const localHosts = new Set([
    '127.0.0.1', 'localhost', '::1', '[::1]', 'host.docker.internal', 'gateway.docker.internal'
  ]);
  if (!['http:', 'https:'].includes(url.protocol)
    || !localHosts.has(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/\/v1\/?$/.test(url.pathname)) {
    throw new Error('--base-url must be a credential-free local OpenAI-compatible /v1 URL.');
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(config.corpus)) throw new Error('--corpus contains unsupported characters.');
  if (!config.model || config.model.length > 256) throw new Error('--model must contain 1 to 256 characters.');
  if (config.topK > 100) throw new Error('--top-k must not exceed 100.');
  if (config.chunkTokens > 8_192) throw new Error('--chunk-tokens must not exceed 8192.');
  if (config.overlapTokens >= config.chunkTokens) throw new Error('--overlap-tokens must be smaller than --chunk-tokens.');
  if (config.maxOutputTokens > 256) throw new Error('--max-output-tokens must not exceed 256.');
  if (config.providerTimeoutMs > 3_600_000) throw new Error('--provider-timeout-ms must not exceed 3600000.');
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function cleanText(value) {
  return String(value || '').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function format(value) {
  return Number(value || 0).toFixed(3);
}
