import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/http/server.js';
import { RaglensStore } from '../src/services/store.js';
import { findOpenPort } from './smoke-utils.js';

const NORMALIZED_DIR = path.join('corpora', 'normalized');
const RESULTS_DIR = path.join('corpora', 'results');
const DEFAULT_RESULTS_PATH = path.join(RESULTS_DIR, 'app-demo.json');
const DEFAULT_REPORT_PATH = path.join('docs', 'app-corpus-demo.md');
const DEFAULT_SETTINGS = {
  topK: 6,
  maxClaims: 4,
  chunkTokens: 120,
  overlapTokens: 24,
  temperature: 0,
  provider: 'local',
  model: 'local-extractive-v1',
  retrievalMode: 'hybrid',
  promptTemplate: 'Answer using only the retrieved context. Cite every factual claim with the source label.',
  promptLoggingEnabled: false,
  redactionEnabled: true,
  rerank: true
};

const options = parseArgs(process.argv.slice(2));
await mkdir(RESULTS_DIR, { recursive: true });

const corpora = {
  squad: await readCorpus('squad'),
  stratrag: await readCorpus('stratrag'),
  scifact: await readCorpus('scifact')
};
const demo = buildDemoSelection(corpora, options);
const result = await runAppDemo(demo, options);

await writeJson(options.out, result);
console.log(`Wrote ${options.out}`);

if (options.report) {
  await writeFile(options.report, renderReport(result));
  console.log(`Wrote ${options.report}`);
}

async function runAppDemo(demo, options) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'raglens-corpus-app-'));
  const port = await findOpenPort();
  const config = loadConfig({
    RAGLENS_HOST: '127.0.0.1',
    RAGLENS_PORT: String(port),
    RAGLENS_DATA_DIR: dataDir,
    RAGLENS_AUTO_SEED: 'false'
  });
  const store = new RaglensStore(config);
  await store.load();

  const server = createServer({ config, store });
  await new Promise((resolve) => server.listen(port, config.host, resolve));
  const baseUrl = `http://${config.host}:${port}`;

  try {
    await readJson(`${baseUrl}/api/health`);
    await readJson(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify(DEFAULT_SETTINGS)
    });

    const indexedDocuments = [];
    for (const document of demo.documents) {
      const indexed = await readJson(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          title: appTitle(document.title),
          sourceType: document.sourceType || 'text',
          text: document.text
        })
      });
      indexedDocuments.push(indexed.document);
    }

    for (const question of demo.questions) {
      await readJson(`${baseUrl}/api/eval-questions`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          question: question.question,
          expectedSource: appTitle(question.expectedSources[0]),
          expectedAnswer: question.expectedAnswer || ''
        })
      });
    }

    const rows = [];
    for (const question of demo.questions) {
      const createdRun = await readJson(`${baseUrl}/api/query-runs`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          question: question.question,
          topK: options.topK,
          maxClaims: options.maxClaims,
          retrievalMode: 'hybrid',
          rerank: true,
          promptLoggingEnabled: false
        })
      });
      const run = await readJson(`${baseUrl}/api/query-runs/${createdRun.id}`);
      rows.push(summarizeRun(question, run));
    }

    const state = await readJson(`${baseUrl}/api/state`);
    const bundle = await readJson(`${baseUrl}/api/query-runs/${rows[0].runId}/bundle`);

    return {
      schemaVersion: 'raglens-app-corpus-demo/v1',
      generatedAt: new Date().toISOString(),
      baseUrl,
      config: {
        ...DEFAULT_SETTINGS,
        topK: options.topK,
        maxClaims: options.maxClaims
      },
      appState: {
        documents: state.documents.length,
        chunks: state.chunks.length,
        evalQuestions: state.evalQuestions.length,
        runs: state.runs.length
      },
      indexedDocuments: indexedDocuments.length,
      bundle: {
        schema: bundle.schema,
        runId: bundle.run?.id || null,
        evidenceDocuments: bundle.evidence?.documents?.length || 0,
        evidenceChunks: bundle.evidence?.chunks?.length || 0,
        promptTextIncluded: Boolean(bundle.run?.prompt?.text)
      },
      summary: summarizeRows(rows),
      rows
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildDemoSelection(corpora, options) {
  const selections = [
    selectCorpus(corpora.squad, { questionLimit: options.squadQuestions, maxDocuments: 12 }),
    selectCorpus(corpora.stratrag, { questionLimit: options.stratragQuestions, maxDocuments: 90 }),
    selectCorpus(corpora.scifact, { questionLimit: options.scifactQuestions, maxDocuments: 45 })
  ];

  return {
    documents: dedupeByTitle(selections.flatMap((selection) => selection.documents)),
    questions: selections.flatMap((selection) => selection.questions)
  };
}

function selectCorpus(corpus, options) {
  const documentByTitle = new Map(corpus.documents.map((document) => [document.title, document]));
  const questions = corpus.questions
    .filter((question) => (question.expectedSources || []).some((source) => documentByTitle.has(source)))
    .slice(0, options.questionLimit);
  const selected = new Map();

  for (const question of questions) {
    for (const source of question.expectedSources || []) {
      const document = documentByTitle.get(source);
      if (document) {
        selected.set(document.title, document);
      }
    }
  }

  for (const document of corpus.documents) {
    if (selected.size >= options.maxDocuments) {
      break;
    }
    selected.set(document.title, document);
  }

  return {
    documents: [...selected.values()],
    questions: questions.map((question) => ({
      ...question,
      corpusName: corpus.name,
      expectedSources: question.expectedSources.map(appTitle)
    }))
  };
}

function summarizeRun(question, run) {
  const expectedSources = question.expectedSources || [];
  const retrieved = run.retrieved || [];
  const hitRanks = expectedSources
    .map((source) => {
      const hit = retrieved.find((item) => item.document?.title === source || item.chunk?.documentTitle === source);
      return hit ? hit.rank : null;
    })
    .filter((rank) => rank !== null);
  const metrics = run.evaluation?.metrics || {};

  return {
    runId: run.id,
    question: question.question,
    corpus: question.corpusName || question.tags?.[0] || 'unknown',
    expectedSources,
    topSource: retrieved[0]?.document?.title || retrieved[0]?.chunk?.documentTitle || null,
    anySourceHit: hitRanks.length > 0,
    allSourcesHit: expectedSources.length > 0 && hitRanks.length === expectedSources.length,
    sourceRecallAtK: expectedSources.length ? round(hitRanks.length / expectedSources.length) : 0,
    mrr: hitRanks.length ? round(1 / Math.min(...hitRanks)) : 0,
    appRecallAtK: metrics.recallAtK || 0,
    appMrr: metrics.mrr || 0,
    faithfulness: metrics.faithfulness || 0,
    citationCoverage: metrics.citationCoverage || 0,
    expectedAnswerCoverage: metrics.expectedAnswerCoverage || 0,
    warnings: (run.evaluation?.warnings || []).map((warning) => warning.type),
    citationCount: run.answer?.citations?.length || 0
  };
}

function summarizeRows(rows) {
  return {
    questions: rows.length,
    anySourceRecallAtK: average(rows.map((row) => row.anySourceHit ? 1 : 0)),
    allSourceRecallAtK: average(rows.map((row) => row.allSourcesHit ? 1 : 0)),
    sourceRecallAtK: average(rows.map((row) => row.sourceRecallAtK)),
    mrr: average(rows.map((row) => row.mrr)),
    appRecallAtK: average(rows.map((row) => row.appRecallAtK)),
    appMrr: average(rows.map((row) => row.appMrr)),
    faithfulness: average(rows.map((row) => row.faithfulness)),
    citationCoverage: average(rows.map((row) => row.citationCoverage)),
    expectedAnswerCoverage: average(rows.map((row) => row.expectedAnswerCoverage)),
    citationCount: average(rows.map((row) => row.citationCount))
  };
}

function renderReport(result) {
  const lines = [
    '# App Corpus Demo',
    '',
    'This report is produced by `npm run corpus:app-demo -- --report`. It drives the same HTTP API used by the browser app: settings, document ingestion, eval question creation, query runs, state hydration, and run bundle export.',
    '',
    `Run date: ${result.generatedAt}`,
    '',
    `App state after run: ${result.appState.documents} documents, ${result.appState.chunks} chunks, ${result.appState.evalQuestions} eval questions, ${result.appState.runs} runs.`,
    '',
    `Bundle check: ${result.bundle.schema} for ${result.bundle.runId}, with ${result.bundle.evidenceDocuments} evidence documents and ${result.bundle.evidenceChunks} evidence chunks. Prompt text included: ${result.bundle.promptTextIncluded ? 'yes' : 'no'}.`,
    '',
    '## Summary',
    '',
    '| Questions | Any Source Recall@K | All Source Recall@K | Source Recall@K | App Recall@K | MRR | Faithfulness | Citation Coverage | Expected Answer Coverage | Avg Citations |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${[
      result.summary.questions,
      fmt(result.summary.anySourceRecallAtK),
      fmt(result.summary.allSourceRecallAtK),
      fmt(result.summary.sourceRecallAtK),
      fmt(result.summary.appRecallAtK),
      fmt(result.summary.mrr),
      fmt(result.summary.faithfulness),
      fmt(result.summary.citationCoverage),
      fmt(result.summary.expectedAnswerCoverage),
      fmt(result.summary.citationCount)
    ].join(' | ')} |`,
    '',
    '`App Recall@K` is RAGLens built-in recall for the first expected source saved with the eval question. The any/all source columns are added by this script for multi-source external questions.',
    '',
    '## Sample Runs',
    '',
    '| Corpus | Question | Top Source | Any Source Hit | Citation Coverage | Warnings |',
    '| --- | --- | --- | --- | ---: | --- |'
  ];

  for (const row of sampleRows(result.rows)) {
    lines.push(`| ${[
      escapeCell(row.corpus),
      escapeCell(row.question),
      escapeCell(row.topSource || ''),
      row.anySourceHit ? 'yes' : 'no',
      fmt(row.citationCoverage),
      escapeCell(row.warnings.join(', ') || 'none')
    ].join(' | ')} |`);
  }

  lines.push(
    '',
    'The broader benchmark-style corpus numbers live in `docs/corpus-evaluation.md`. This page is narrower on purpose: it demonstrates that external corpus data can move through the app/API workflow end to end.'
  );

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function sampleRows(rows) {
  const byCorpus = new Map();
  for (const row of rows) {
    const group = byCorpus.get(row.corpus) || [];
    if (group.length < 4) {
      group.push(row);
      byCorpus.set(row.corpus, group);
    }
  }
  return [...byCorpus.values()].flat();
}

async function readCorpus(name) {
  try {
    return JSON.parse(await readFile(path.join(NORMALIZED_DIR, `${name}.json`), 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${name}. Run npm run corpus:fetch first. ${error.message}`);
  }
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function dedupeByTitle(documents) {
  return [...new Map(documents.map((document) => [appTitle(document.title), {
    ...document,
    title: appTitle(document.title)
  }])).values()];
}

function appTitle(title) {
  return String(title || '').slice(0, 160);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    out: DEFAULT_RESULTS_PATH,
    report: DEFAULT_REPORT_PATH,
    topK: 6,
    maxClaims: 4,
    squadQuestions: 8,
    stratragQuestions: 6,
    scifactQuestions: 8
  };

  for (const arg of args) {
    if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--report=')) {
      options.report = arg.slice('--report='.length);
    } else if (arg === '--no-report') {
      options.report = '';
    } else if (arg.startsWith('--top-k=')) {
      options.topK = numberOption(arg, '--top-k=', options.topK);
    } else if (arg.startsWith('--max-claims=')) {
      options.maxClaims = numberOption(arg, '--max-claims=', options.maxClaims);
    } else if (arg.startsWith('--squad-questions=')) {
      options.squadQuestions = numberOption(arg, '--squad-questions=', options.squadQuestions);
    } else if (arg.startsWith('--stratrag-questions=')) {
      options.stratragQuestions = numberOption(arg, '--stratrag-questions=', options.stratragQuestions);
    } else if (arg.startsWith('--scifact-questions=')) {
      options.scifactQuestions = numberOption(arg, '--scifact-questions=', options.scifactQuestions);
    }
  }

  return options;
}

function numberOption(arg, prefix, fallback) {
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}
