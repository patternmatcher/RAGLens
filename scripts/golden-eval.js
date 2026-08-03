import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { EmbeddingCache, embedChunks, embedTexts } from '../src/rag/embedding-provider.js';
import { runRagInspection } from '../src/rag/pipeline.js';
import { planQuery } from '../src/rag/query.js';

const options = parseArgs(process.argv.slice(2));
const suite = JSON.parse(await readFile(options.suite, 'utf8'));
validateSuite(suite);

const benchmark = {
  schemaVersion: 'raglens.rag-benchmark/v1',
  generatedAt: new Date().toISOString(),
  suite: {
    schemaVersion: suite.schemaVersion,
    name: suite.name,
    cases: suite.cases.length,
    documents: suite.documents.length,
    categories: categoryCounts(suite.cases)
  },
  profiles: []
};

for (const profile of profiles()) {
  benchmark.profiles.push(await runProfile(suite, profile));
}

benchmark.comparison = compareProfiles(benchmark.profiles[0], benchmark.profiles[1]);
benchmark.gate = evaluateGate(benchmark);

if (options.out) await writeOutput(options.out, benchmark);
if (options.report) await writeOutput(options.report, renderReport(benchmark));

for (const profile of benchmark.profiles) {
  console.log(`${profile.name}: hit ${format(profile.metrics.hitRateAtK)}, MRR ${format(profile.metrics.mrr)}, NDCG ${format(profile.metrics.ndcgAtK)}, abstention ${format(profile.metrics.abstentionAccuracy)}`);
}
console.log(`Golden evaluation gate: ${benchmark.gate.passed ? 'passed' : 'failed'}`);

if (options.check && !benchmark.gate.passed) {
  for (const failure of benchmark.gate.failures) console.error(`- ${failure}`);
  process.exit(1);
}

async function runProfile(suiteValue, profile) {
  const cache = new EmbeddingCache();
  const documents = suiteValue.documents.map((document) => createDocument({
    ...document,
    projectId: 'golden-eval'
  }));
  const chunked = documents.flatMap((document) => chunkDocument(document, profile.chunking));
  const embedded = await embedChunks(chunked, {
    provider: 'local',
    projectId: 'golden-eval',
    cache
  });
  const plannedQueries = await Promise.all(suiteValue.cases.map((item) => planQuery(item.question, {
    enabled: profile.queryRewrite
  })));
  const queryWarmup = await embedTexts(plannedQueries.flatMap((query) => query.searchQueries), {
    provider: 'local',
    projectId: 'golden-eval',
    cache
  });
  const heapStart = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const rows = [];

  for (const item of suiteValue.cases) {
    const run = await runRagInspection({
      question: item.question,
      chunks: embedded.chunks,
      config: {
        ...profile.retrieval,
        metadataFilter: profile.useMetadataFilters ? item.metadataFilter || {} : {},
        maxClaims: 6,
        chunkTokens: profile.chunking.maxTokens,
        overlapTokens: profile.chunking.overlapTokens,
        expectedSources: item.expectedSources,
        expectedAnswer: item.expectedAnswer,
        embedding: {
          provider: 'local',
          projectId: 'golden-eval',
          cache
        },
        queryRewrite: { enabled: profile.queryRewrite }
      }
    });
    rows.push(summarizeCase(item, run));
  }

  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapStart);
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    config: profile,
    corpus: { documents: documents.length, chunks: embedded.chunks.length },
    metrics: aggregate(rows),
    cache: {
      documentColdHits: embedded.metrics.cache.hits,
      documentColdMisses: embedded.metrics.cache.misses,
      queryWarmupHits: queryWarmup.cache.hits,
      queryWarmupMisses: queryWarmup.cache.misses,
      measuredHits: sum(rows.map((row) => row.embeddingCacheHits)),
      measuredMisses: sum(rows.map((row) => row.embeddingCacheMisses))
    },
    resources: {
      elapsedMs,
      averageLatencyMs: average(rows.map((row) => row.latencyMs)),
      p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.95),
      heapDeltaBytes,
      totalInputTokens: sum(rows.map((row) => row.inputTokens)),
      totalOutputTokens: sum(rows.map((row) => row.outputTokens))
    },
    cases: rows
  };
}

function summarizeCase(item, run) {
  const metrics = run.evaluation.metrics;
  const shouldAbstain = item.expectAbstain === true;
  const abstained = run.answer.abstained === true;
  return {
    id: item.id,
    category: item.category,
    question: item.question,
    expectedSources: item.expectedSources,
    expectedAnswer: item.expectedAnswer,
    shouldAbstain,
    abstained,
    correctAbstention: shouldAbstain === abstained,
    hitRateAtK: metrics.hitRateAtK || 0,
    precisionAtK: metrics.precisionAtK || 0,
    recallAtK: metrics.recallAtK || 0,
    mrr: metrics.mrr || 0,
    ndcgAtK: metrics.ndcgAtK || 0,
    faithfulness: metrics.faithfulness || 0,
    citationCoverage: metrics.citationCoverage || 0,
    expectedAnswerCoverage: metrics.expectedAnswerCoverage || 0,
    latencyMs: run.latencyMs,
    inputTokens: run.usage.inputTokens || 0,
    outputTokens: run.usage.outputTokens || 0,
    embeddingCacheHits: run.usage.embeddingCache?.hits || 0,
    embeddingCacheMisses: run.usage.embeddingCache?.misses || 0,
    warningTypes: run.warnings.map((warning) => warning.type),
    topEvidenceId: run.retrieved[0]?.chunkId || null
  };
}

function aggregate(rows) {
  const answerable = rows.filter((row) => !row.shouldAbstain);
  const abstention = rows.filter((row) => row.shouldAbstain);
  return {
    cases: rows.length,
    answerableCases: answerable.length,
    abstentionCases: abstention.length,
    hitRateAtK: average(answerable.map((row) => row.hitRateAtK)),
    precisionAtK: average(answerable.map((row) => row.precisionAtK)),
    recallAtK: average(answerable.map((row) => row.recallAtK)),
    mrr: average(answerable.map((row) => row.mrr)),
    ndcgAtK: average(answerable.map((row) => row.ndcgAtK)),
    faithfulness: average(answerable.map((row) => row.faithfulness)),
    citationCoverage: average(answerable.map((row) => row.citationCoverage)),
    expectedAnswerCoverage: average(answerable.map((row) => row.expectedAnswerCoverage)),
    abstentionAccuracy: average(rows.map((row) => row.correctAbstention ? 1 : 0)),
    adversarialAbstentionRate: average(abstention.map((row) => row.abstained ? 1 : 0)),
    answerableAbstentionRate: average(answerable.map((row) => row.abstained ? 1 : 0))
  };
}

function profiles() {
  return [
    {
      id: 'naive',
      name: 'Naive retrieval',
      description: 'Single unmodified query, keyword retrieval, no candidate rerank, and no parent context.',
      chunking: { maxTokens: 500, overlapTokens: 50 },
      queryRewrite: false,
      useMetadataFilters: false,
      retrieval: { topK: 4, candidateDepth: 4, retrievalMode: 'keyword', rerank: false, parentContext: false }
    },
    {
      id: 'enhanced',
      name: 'Enhanced RAGLens retrieval',
      description: 'Deterministic rewrite and decomposition, hybrid retrieval, deeper candidates, reranking, metadata filters, and bounded parent context.',
      chunking: { maxTokens: 500, overlapTokens: 50 },
      queryRewrite: true,
      useMetadataFilters: true,
      retrieval: { topK: 6, candidateDepth: 24, retrievalMode: 'hybrid', rerank: true, parentContext: true, parentContextMaxTokens: 1_500 }
    }
  ];
}

function compareProfiles(baseline, enhanced) {
  const keys = ['hitRateAtK', 'precisionAtK', 'recallAtK', 'mrr', 'ndcgAtK', 'faithfulness', 'citationCoverage', 'expectedAnswerCoverage', 'abstentionAccuracy'];
  return Object.fromEntries(keys.map((key) => [key, {
    baseline: baseline.metrics[key],
    enhanced: enhanced.metrics[key],
    delta: round(enhanced.metrics[key] - baseline.metrics[key])
  }]));
}

function evaluateGate(benchmarkValue) {
  const enhanced = benchmarkValue.profiles.find((profile) => profile.id === 'enhanced');
  const baseline = benchmarkValue.profiles.find((profile) => profile.id === 'naive');
  const checks = [
    [benchmarkValue.suite.cases >= 50, 'The golden suite must contain at least 50 cases.'],
    [enhanced.metrics.hitRateAtK >= 0.9, 'Enhanced answerable hit rate must be at least 0.90.'],
    [enhanced.metrics.mrr >= 0.8, 'Enhanced MRR must be at least 0.80.'],
    [enhanced.metrics.ndcgAtK >= 0.8, 'Enhanced NDCG at k must be at least 0.80.'],
    [enhanced.metrics.citationCoverage >= 0.8, 'Enhanced citation coverage must be at least 0.80.'],
    [enhanced.metrics.adversarialAbstentionRate >= 0.8, 'Adversarial abstention rate must be at least 0.80.'],
    [enhanced.metrics.answerableAbstentionRate <= 0.1, 'Answerable abstention rate must be at most 0.10.'],
    [enhanced.metrics.hitRateAtK >= baseline.metrics.hitRateAtK, 'Enhanced hit rate must not regress from naive retrieval.'],
    [enhanced.metrics.ndcgAtK >= baseline.metrics.ndcgAtK, 'Enhanced NDCG must not regress from naive retrieval.']
  ];
  const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
  return { passed: failures.length === 0, failures };
}

function renderReport(value) {
  const [baseline, enhanced] = value.profiles;
  const lines = [
    '# Naive vs Enhanced RAG Benchmark',
    '',
    `Suite: ${value.suite.name} (${value.suite.cases} cases, ${value.suite.documents} documents)`,
    '',
    'Both profiles use 500-token chunks with 50-token overlap. The naive profile uses one keyword query with no reranking. The enhanced profile adds query expansion and decomposition, hybrid retrieval, a deeper candidate pool, reranking, metadata filters, and bounded parent context.',
    '',
    '| Metric | Naive | Enhanced | Delta |',
    '| --- | ---: | ---: | ---: |'
  ];
  for (const [key, comparison] of Object.entries(value.comparison)) {
    lines.push(`| ${key} | ${format(comparison.baseline)} | ${format(comparison.enhanced)} | ${signed(comparison.delta)} |`);
  }
  lines.push(
    '',
    '## Runtime',
    '',
    '| Profile | Average latency | P95 latency | Measured embedding cache hits | Input tokens | Output tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| ${baseline.name} | ${formatMs(baseline.resources.averageLatencyMs)} | ${formatMs(baseline.resources.p95LatencyMs)} | ${baseline.cache.measuredHits} | ${baseline.resources.totalInputTokens} | ${baseline.resources.totalOutputTokens} |`,
    `| ${enhanced.name} | ${formatMs(enhanced.resources.averageLatencyMs)} | ${formatMs(enhanced.resources.p95LatencyMs)} | ${enhanced.cache.measuredHits} | ${enhanced.resources.totalInputTokens} | ${enhanced.resources.totalOutputTokens} |`,
    '',
    '## Gate',
    '',
    value.gate.passed ? 'Passed.' : `Failed: ${value.gate.failures.join(' ')}`,
    '',
    'The benchmark is a repository regression gate, not a claim about general model quality. It isolates changes in this corpus, chunking, retrieval, evidence selection, grounding, and abstention path.',
    ''
  );
  return lines.join('\n');
}

function validateSuite(value) {
  if (value.schemaVersion !== 'raglens.golden-eval/v1') throw new Error('Unsupported golden suite schema.');
  if (!Array.isArray(value.documents) || value.documents.length < 5) throw new Error('Golden suite needs at least five documents.');
  if (!Array.isArray(value.cases) || value.cases.length < 50) throw new Error('Golden suite needs at least 50 cases.');
  const ids = new Set(value.cases.map((item) => item.id));
  if (ids.size !== value.cases.length) throw new Error('Golden case IDs must be unique.');
  for (const item of value.cases) {
    if (!item.question || !Array.isArray(item.expectedSources)) throw new Error(`Golden case ${item.id} is incomplete.`);
  }
}

function parseArgs(args) {
  const parsed = { suite: 'evals/golden-rag-v1.json', out: '', report: '', check: args.includes('--check') };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--suite') parsed.suite = args[++index];
    else if (args[index] === '--out') parsed.out = args[++index];
    else if (args[index] === '--report') parsed.report = args[++index];
  }
  return parsed;
}

async function writeOutput(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, typeof value === 'string' ? `${value.trim()}\n` : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function categoryCounts(cases) {
  return Object.fromEntries([...new Set(cases.map((item) => item.category))].sort().map((category) => [category, cases.filter((item) => item.category === category).length]));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] || 0);
}

function average(values) {
  return values.length ? round(sum(values) / values.length) : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function round(value) {
  return Number(Number(value || 0).toFixed(3));
}

function format(value) {
  return Number(value || 0).toFixed(3);
}

function signed(value) {
  return `${value >= 0 ? '+' : ''}${format(value)}`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(2)} ms`;
}
