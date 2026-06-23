import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { runRagInspection } from '../src/rag/pipeline.js';

const NORMALIZED_DIR = path.join('corpora', 'normalized');
const RESULTS_DIR = path.join('corpora', 'results');
const DEFAULT_RESULTS_PATH = path.join(RESULTS_DIR, 'latest.json');
const DEFAULT_REPORT_PATH = path.join('docs', 'corpus-evaluation.md');
const DEFAULT_CONFIG = {
  topK: 6,
  maxClaims: 4,
  retrievalMode: 'hybrid',
  rerank: true,
  provider: 'local',
  model: 'local-extractive-v1',
  temperature: 0,
  promptTemplate: 'Answer using only the retrieved context. Cite every factual claim with the source label.',
  promptLoggingEnabled: false,
  openaiCompatible: { configured: false },
  costRates: { configured: false }
};

const options = parseArgs(process.argv.slice(2));
await mkdir(RESULTS_DIR, { recursive: true });

const corpora = await loadCorpora(options);
if (!corpora.length) {
  throw new Error(`No normalized corpora found in ${NORMALIZED_DIR}. Run npm run corpus:fetch first.`);
}

const startedAt = Date.now();
const results = [];
for (const corpus of corpora) {
  results.push(await evaluateCorpus(corpus, options));
}

const output = {
  schemaVersion: 'raglens-corpus-results/v1',
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  config: {
    topK: options.topK,
    maxClaims: options.maxClaims,
    questionLimit: options.questionLimit,
    chunkTokens: options.chunkTokens,
    overlapTokens: options.overlapTokens
  },
  results
};

await writeJson(options.out, output);
console.log(`Wrote ${options.out}`);

if (options.report) {
  await writeFile(options.report, renderReport(output));
  console.log(`Wrote ${options.report}`);
}

if (options.strict) {
  const failures = results.filter((result) => result.summary.anySourceRecallAtK < options.minRecall);
  if (failures.length) {
    for (const failure of failures) {
      console.error(`${failure.name} missed strict any-source recall threshold: ${failure.summary.anySourceRecallAtK}`);
    }
    process.exit(1);
  }
}

async function loadCorpora(options) {
  const names = options.sources.length ? options.sources : ['squad', 'stratrag', 'scifact'];
  const corpora = [];

  for (const name of names) {
    try {
      corpora.push(JSON.parse(await readFile(path.join(NORMALIZED_DIR, `${name}.json`), 'utf8')));
    } catch (error) {
      if (options.allowMissing) {
        console.warn(`Skipping ${name}: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  return corpora;
}

async function evaluateCorpus(corpus, options) {
  const documents = corpus.documents.map((document) =>
    createDocument({
      title: document.title,
      sourceType: document.sourceType || 'text',
      text: document.text,
      metadata: document.metadata || {},
      projectId: corpus.key
    })
  );
  const chunks = documents.flatMap((document) =>
    chunkDocument(document, {
      maxTokens: options.chunkTokens,
      overlapTokens: options.overlapTokens
    })
  );
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const documentTitles = new Set(documents.map((document) => document.title));
  const questions = corpus.questions
    .filter((question) => (question.expectedSources || []).some((source) => documentTitles.has(source)))
    .slice(0, options.questionLimit);
  const rows = [];

  for (const question of questions) {
    const inspection = await runRagInspection({
      question: question.question,
      chunks,
      config: {
        ...DEFAULT_CONFIG,
        topK: options.topK,
        maxClaims: options.maxClaims,
        chunkTokens: options.chunkTokens,
        overlapTokens: options.overlapTokens,
        expectedSource: question.expectedSources?.[0] || '',
        expectedAnswer: question.expectedAnswer || ''
      }
    });

    rows.push(summarizeQuestion(question, inspection, chunksById));
  }

  const summary = summarizeRows(rows);
  console.log(`${corpus.name}: ${summary.questions} questions, any-source recall ${summary.anySourceRecallAtK}`);

  return {
    key: corpus.key,
    name: corpus.name,
    sourceUrl: corpus.sourceUrl,
    documents: documents.length,
    chunks: chunks.length,
    questions: rows.length,
    summary,
    rows
  };
}

function summarizeQuestion(question, inspection, chunksById) {
  const expectedSources = question.expectedSources || [];
  const retrieved = inspection.retrieved || [];
  const sourceRanks = expectedSources
    .map((source) => {
      const hit = retrieved.find((item) => chunksById.get(item.chunkId)?.documentTitle === source);
      return hit ? hit.rank : null;
    });
  const hitRanks = sourceRanks.filter((rank) => rank !== null);
  const metrics = inspection.evaluation?.metrics || {};

  return {
    id: question.id,
    question: question.question,
    expectedSources,
    expectedAnswerAvailable: Boolean(question.expectedAnswer),
    retrievedTopSource: chunksById.get(retrieved[0]?.chunkId)?.documentTitle || null,
    expectedSourceHits: hitRanks.length,
    expectedSourceCount: expectedSources.length,
    anySourceHit: hitRanks.length > 0,
    allSourcesHit: expectedSources.length > 0 && hitRanks.length === expectedSources.length,
    sourceRecallAtK: expectedSources.length ? round(hitRanks.length / expectedSources.length) : 0,
    mrr: hitRanks.length ? round(1 / Math.min(...hitRanks)) : 0,
    faithfulness: metrics.faithfulness || 0,
    citationCoverage: metrics.citationCoverage || 0,
    contextRelevance: metrics.contextRelevance || 0,
    expectedAnswerCoverage: metrics.expectedAnswerCoverage || 0,
    warnings: (inspection.evaluation?.warnings || []).map((warning) => warning.type)
  };
}

function summarizeRows(rows) {
  const answerRows = rows.filter((row) => row.expectedAnswerAvailable);

  return {
    questions: rows.length,
    anySourceRecallAtK: average(rows.map((row) => row.anySourceHit ? 1 : 0)),
    allSourceRecallAtK: average(rows.map((row) => row.allSourcesHit ? 1 : 0)),
    sourceRecallAtK: average(rows.map((row) => row.sourceRecallAtK)),
    mrr: average(rows.map((row) => row.mrr)),
    faithfulness: average(rows.map((row) => row.faithfulness)),
    citationCoverage: average(rows.map((row) => row.citationCoverage)),
    contextRelevance: average(rows.map((row) => row.contextRelevance)),
    expectedAnswerCoverage: average(answerRows.map((row) => row.expectedAnswerCoverage)),
    unsupportedClaimRate: average(rows.map((row) => row.warnings.includes('unsupported-claim') ? 1 : 0))
  };
}

function renderReport(output) {
  const lines = [
    '# Corpus Evaluation',
    '',
    'This report is produced by `npm run corpus:eval -- --report`. Downloaded corpus files stay under `corpora/`, which is ignored by git.',
    '',
    `Run date: ${output.generatedAt}`,
    '',
    `Config: top-k ${output.config.topK}, max claims ${output.config.maxClaims}, chunk tokens ${output.config.chunkTokens}, overlap ${output.config.overlapTokens}, question limit ${output.config.questionLimit}.`,
    '',
    '## Summary',
    '',
    '| Corpus | Docs | Chunks | Questions | Any Source Recall@K | All Source Recall@K | Source Recall@K | MRR | Faithfulness | Citation Coverage | Expected Answer Coverage |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  for (const result of output.results) {
    lines.push(`| ${[
      result.name,
      result.documents,
      result.chunks,
      result.questions,
      fmt(result.summary.anySourceRecallAtK),
      fmt(result.summary.allSourceRecallAtK),
      fmt(result.summary.sourceRecallAtK),
      fmt(result.summary.mrr),
      fmt(result.summary.faithfulness),
      fmt(result.summary.citationCoverage),
      fmt(result.summary.expectedAnswerCoverage)
    ].join(' | ')} |`);
  }

  lines.push(
    '',
    '## Corpus Notes',
    '',
    '- SQuAD checks clean single-passage Wikipedia question answering.',
    '- StratRAG checks HotpotQA-derived multi-hop questions with distractor document pools.',
    '- SciFact checks retrieval against scientific claim evidence documents.',
    '',
    'These numbers are not meant to compete with benchmark leaderboards. They are a regression signal for this app: chunking, retrieval, citations, claim support, and report export should keep working on real external data.',
    '',
    '## Sources',
    ''
  );

  for (const result of output.results) {
    lines.push(`- ${result.name}: ${result.sourceUrl}`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function parseArgs(args) {
  const options = {
    sources: [],
    out: DEFAULT_RESULTS_PATH,
    report: DEFAULT_REPORT_PATH,
    allowMissing: args.includes('--allow-missing'),
    strict: args.includes('--strict'),
    minRecall: 0.45,
    topK: 6,
    maxClaims: 4,
    questionLimit: 80,
    chunkTokens: 120,
    overlapTokens: 24
  };

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      options.sources = arg.slice('--source='.length).split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--report=')) {
      options.report = arg.slice('--report='.length);
    } else if (arg === '--no-report') {
      options.report = '';
    } else if (arg.startsWith('--min-recall=')) {
      options.minRecall = numberOption(arg, '--min-recall=', options.minRecall);
    } else if (arg.startsWith('--top-k=')) {
      options.topK = numberOption(arg, '--top-k=', options.topK);
    } else if (arg.startsWith('--max-claims=')) {
      options.maxClaims = numberOption(arg, '--max-claims=', options.maxClaims);
    } else if (arg.startsWith('--limit=')) {
      options.questionLimit = numberOption(arg, '--limit=', options.questionLimit);
    } else if (arg.startsWith('--chunk-tokens=')) {
      options.chunkTokens = numberOption(arg, '--chunk-tokens=', options.chunkTokens);
    } else if (arg.startsWith('--overlap-tokens=')) {
      options.overlapTokens = numberOption(arg, '--overlap-tokens=', options.overlapTokens);
    }
  }

  return options;
}

function numberOption(arg, prefix, fallback) {
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) {
    return 0;
  }
  return round(usable.reduce((sum, value) => sum + value, 0) / usable.length);
}

function fmt(value) {
  return Number(value || 0).toFixed(3);
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
