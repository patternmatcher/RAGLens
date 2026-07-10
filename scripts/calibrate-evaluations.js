import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chunkDocument, createDocument } from '../src/rag/chunker.js';
import { runRagInspection } from '../src/rag/pipeline.js';

const options = parseArgs(process.argv.slice(2));
const cases = [];

for (const source of options.sources) {
  const corpus = JSON.parse(await readFile(path.join('corpora', 'normalized', `${source}.json`), 'utf8'));
  cases.push(...await buildCases(corpus, options));
}

const metrics = [
  ['evidenceQuality', 'Runtime evidence quality'],
  ['retrievalConfidence', 'Retrieval confidence'],
  ['contextRelevance', 'Context relevance'],
  ['faithfulness', 'Faithfulness'],
  ['citationCoverage', 'Citation coverage'],
  ['sourceRecallAtK', 'Expected source recall@k'],
  ['mrr', 'Expected source MRR'],
  ['expectedAnswerCoverage', 'Expected answer coverage']
].map(([key, label]) => calibrateMetric(key, label, cases));

const output = {
  schemaVersion: 'raglens-evaluation-calibration/v1',
  generatedAt: new Date().toISOString(),
  target: 'Expected source evidence is present in the retrieved top-k context.',
  method: {
    controls: 'Each question is run normally and with every expected-source document removed.',
    split: 'Question pairs are assigned deterministically to an 80 percent calibration split or a 20 percent validation split.',
    thresholdSelection: 'Maximize balanced accuracy, then minimize false positives on the calibration split.',
    excludedFromRuntimeComposite: ['sourceRecallAtK', 'mrr', 'expectedAnswerCoverage', 'citationCoverage']
  },
  config: {
    sources: options.sources,
    questionLimitPerCorpus: options.limit,
    topK: options.topK,
    chunkTokens: options.chunkTokens,
    overlapTokens: options.overlapTokens
  },
  dataset: summarizeCases(cases),
  corpora: summarizeCorpora(cases),
  metrics
};

await mkdir(path.dirname(options.out), { recursive: true });
await writeFile(options.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
if (options.report) {
  await mkdir(path.dirname(options.report), { recursive: true });
  await writeFile(options.report, renderReport(output), 'utf8');
}

console.log(`Evaluation calibration wrote ${options.out}`);
if (options.report) console.log(`Evaluation calibration wrote ${options.report}`);
for (const metric of metrics) {
  const validation = metric.validation;
  console.log(`${metric.label}: threshold ${format(metric.threshold)}, validation balanced accuracy ${format(validation.balancedAccuracy)}`);
}

async function buildCases(corpus, config) {
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
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const availableTitles = new Set(documents.map((document) => document.title));
  const questions = corpus.questions
    .filter((question) => (question.expectedSources || []).some((source) => availableTitles.has(source)))
    .slice(0, config.limit);
  const rows = [];

  for (const question of questions) {
    const expectedSources = new Set(question.expectedSources || []);
    const sourceRemovedChunks = chunks.filter((chunk) => !expectedSources.has(documentsById.get(chunk.documentId)?.title));
    const split = validationSplit(`${corpus.key}:${question.id}`) ? 'validation' : 'calibration';
    const normal = await inspect(question, chunks, config);
    rows.push(toCase(corpus, question, normal, chunksById, documentsById, 'normal', split));

    if (sourceRemovedChunks.length) {
      const negative = await inspect(question, sourceRemovedChunks, config);
      rows.push(toCase(corpus, question, negative, chunksById, documentsById, 'source-removed', split));
    }
  }

  return rows;
}

function inspect(question, chunks, config) {
  return runRagInspection({
    question: question.question,
    chunks,
    config: {
      topK: config.topK,
      maxClaims: 4,
      chunkTokens: config.chunkTokens,
      overlapTokens: config.overlapTokens,
      retrievalMode: 'hybrid',
      rerank: true,
      provider: 'local',
      model: 'local-extractive-v1',
      temperature: 0,
      promptLoggingEnabled: false,
      expectedSource: question.expectedSources?.[0] || '',
      expectedSources: question.expectedSources || [],
      expectedAnswer: question.expectedAnswer || '',
      openaiCompatible: { configured: false },
      costRates: { configured: false }
    }
  });
}

function toCase(corpus, question, run, chunksById, documentsById, control, split) {
  const expectedSources = new Set(question.expectedSources || []);
  const sourceHit = (run.retrieved || []).some((item) => {
    const chunk = chunksById.get(item.chunkId);
    return expectedSources.has(documentsById.get(chunk?.documentId)?.title);
  });
  const values = run.evaluation?.metrics || {};
  const runtimeValues = [
    number(values.retrievalConfidence),
    number(values.contextRelevance),
    number(values.faithfulness)
  ];

  return {
    id: `${corpus.key}:${question.id}:${control}`,
    questionId: String(question.id),
    corpus: corpus.key,
    control,
    split,
    label: sourceHit,
    expectedAnswerAvailable: Boolean(question.expectedAnswer),
    metrics: {
      evidenceQuality: geometricMean(runtimeValues),
      retrievalConfidence: runtimeValues[0],
      contextRelevance: runtimeValues[1],
      faithfulness: runtimeValues[2],
      citationCoverage: number(values.citationCoverage),
      sourceRecallAtK: number(values.sourceRecallAtK),
      mrr: number(values.mrr),
      expectedAnswerCoverage: question.expectedAnswer ? number(values.expectedAnswerCoverage) : null
    }
  };
}

function calibrateMetric(key, label, allCases) {
  const eligible = allCases.filter((item) => Number.isFinite(item.metrics[key]));
  const calibration = eligible.filter((item) => item.split === 'calibration');
  const validation = eligible.filter((item) => item.split === 'validation');
  const threshold = chooseThreshold(calibration, key);
  return {
    key,
    label,
    threshold,
    calibration: scoreThreshold(calibration, key, threshold),
    validation: scoreThreshold(validation, key, threshold),
    validationAuc: auc(validation, key),
    interpretation: interpretation(key)
  };
}

function chooseThreshold(rows, key) {
  const values = [...new Set(rows.map((item) => item.metrics[key]))].sort((left, right) => left - right);
  const candidates = [0, ...values, 1.000001];
  let best = null;
  for (const threshold of candidates) {
    const score = scoreThreshold(rows, key, threshold);
    if (!best
      || score.balancedAccuracy > best.score.balancedAccuracy
      || (score.balancedAccuracy === best.score.balancedAccuracy && score.falsePositiveRate < best.score.falsePositiveRate)
      || (score.balancedAccuracy === best.score.balancedAccuracy
        && score.falsePositiveRate === best.score.falsePositiveRate
        && threshold > best.threshold)) {
      best = { threshold, score };
    }
  }
  return round(best?.threshold || 0);
}

function scoreThreshold(rows, key, threshold) {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const item of rows) {
    const predicted = item.metrics[key] >= threshold;
    if (predicted && item.label) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (item.label) falseNegative += 1;
    else trueNegative += 1;
  }
  const sensitivity = ratio(truePositive, truePositive + falseNegative);
  const specificity = ratio(trueNegative, trueNegative + falsePositive);
  return {
    cases: rows.length,
    positives: truePositive + falseNegative,
    negatives: trueNegative + falsePositive,
    balancedAccuracy: round((sensitivity + specificity) / 2),
    sensitivity,
    specificity,
    falsePositiveRate: round(1 - specificity),
    confusion: { truePositive, trueNegative, falsePositive, falseNegative }
  };
}

function auc(rows, key) {
  const positives = rows.filter((item) => item.label).map((item) => item.metrics[key]);
  const negatives = rows.filter((item) => !item.label).map((item) => item.metrics[key]);
  if (!positives.length || !negatives.length) return 0;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) wins += 0.5;
    }
  }
  return round(wins / (positives.length * negatives.length));
}

function summarizeCases(rows) {
  return {
    cases: rows.length,
    questions: new Set(rows.map((item) => `${item.corpus}:${item.questionId}`)).size,
    normalCases: rows.filter((item) => item.control === 'normal').length,
    sourceRemovedControls: rows.filter((item) => item.control === 'source-removed').length,
    calibrationCases: rows.filter((item) => item.split === 'calibration').length,
    validationCases: rows.filter((item) => item.split === 'validation').length,
    evidencePresent: rows.filter((item) => item.label).length,
    evidenceMissing: rows.filter((item) => !item.label).length
  };
}

function summarizeCorpora(rows) {
  return [...new Set(rows.map((item) => item.corpus))].map((corpus) => {
    const subset = rows.filter((item) => item.corpus === corpus);
    const normal = subset.filter((item) => item.control === 'normal');
    return {
      corpus,
      questions: normal.length,
      normalSourceHitRate: ratio(normal.filter((item) => item.label).length, normal.length),
      sourceRemovedCases: subset.filter((item) => item.control === 'source-removed').length
    };
  });
}

function renderReport(output) {
  const lines = [
    '# Evaluation Calibration',
    '',
    `Run date: ${output.generatedAt}`,
    '',
    'This run checks whether RAGLens evaluation metrics distinguish retrieved contexts that contain the expected source from controlled failures where every expected-source document has been removed.',
    '',
    `The dataset contains ${output.dataset.questions} questions and ${output.dataset.cases} paired cases. Thresholds are selected on ${output.dataset.calibrationCases} cases and checked once on ${output.dataset.validationCases} held-out cases.`,
    '',
    '## Results',
    '',
    '| Metric | Threshold | Validation AUC | Balanced Accuracy | Sensitivity | Specificity | False Positive Rate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for (const metric of output.metrics) {
    lines.push(`| ${metric.label} | ${format(metric.threshold)} | ${format(metric.validationAuc)} | ${format(metric.validation.balancedAccuracy)} | ${format(metric.validation.sensitivity)} | ${format(metric.validation.specificity)} | ${format(metric.validation.falsePositiveRate)} |`);
  }
  lines.push(
    '',
    '## Corpus Coverage',
    '',
    '| Corpus | Questions | Normal Source Hit Rate | Source-Removed Controls |',
    '| --- | ---: | ---: | ---: |'
  );
  for (const corpus of output.corpora) {
    lines.push(`| ${corpus.corpus} | ${corpus.questions} | ${format(corpus.normalSourceHitRate)} | ${corpus.sourceRemovedCases} |`);
  }
  lines.push(
    '',
    '## Reading The Numbers',
    '',
    '- Runtime evidence quality is the geometric mean of retrieval confidence, context relevance, and faithfulness.',
    '- Expected source recall and MRR are available only when an evaluation set supplies acceptable source names.',
    '- Expected answer coverage is available only when an evaluation set supplies a reference answer.',
    '- Citation coverage checks whether claims cite retrieved chunks. It does not prove that the retriever found the right source.',
    '- Source names are used to create labels and negative controls. They are not inputs to the runtime evidence-quality score.',
    '',
    'These thresholds are regression starting points for the bundled retrieval and evaluation heuristics. A deployment should recalibrate them with reviewed domain questions, real failure traces, and the exact embedding, reranking, and generation stack used in production.'
  );
  return `${lines.join('\n')}\n`;
}

function interpretation(key) {
  if (key === 'evidenceQuality') return 'Runtime composite of retrieval confidence, context relevance, and faithfulness.';
  if (key === 'expectedAnswerCoverage') return 'Eval-set metric that requires a reference answer.';
  if (key === 'sourceRecallAtK' || key === 'mrr') return 'Eval-set metric that requires acceptable source names.';
  if (key === 'citationCoverage') return 'Citation presence, not proof that the cited source is the expected source.';
  return 'Individual RAGLens runtime evaluation metric.';
}

function parseArgs(args) {
  const options = {
    sources: ['squad', 'stratrag', 'scifact'],
    limit: 40,
    topK: 6,
    chunkTokens: 120,
    overlapTokens: 24,
    out: path.join('corpora', 'results', 'evaluation-calibration.json'),
    report: path.join('docs', 'evaluation-calibration.md')
  };
  for (const arg of args) {
    if (arg.startsWith('--source=')) options.sources = listValue(arg, '--source=');
    else if (arg.startsWith('--limit=')) options.limit = integerValue(arg, '--limit=', options.limit);
    else if (arg.startsWith('--top-k=')) options.topK = integerValue(arg, '--top-k=', options.topK);
    else if (arg.startsWith('--chunk-tokens=')) options.chunkTokens = integerValue(arg, '--chunk-tokens=', options.chunkTokens);
    else if (arg.startsWith('--overlap-tokens=')) options.overlapTokens = integerValue(arg, '--overlap-tokens=', options.overlapTokens);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length);
    else if (arg === '--no-report') options.report = '';
  }
  return options;
}

function validationSplit(value) {
  return createHash('sha256').update(value).digest()[0] % 5 === 0;
}

function listValue(arg, prefix) {
  return arg.slice(prefix.length).split(',').map((item) => item.trim()).filter(Boolean);
}

function integerValue(arg, prefix, fallback) {
  const value = Number(arg.slice(prefix.length));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function geometricMean(values) {
  if (values.some((value) => value <= 0)) return 0;
  return round(Math.pow(values.reduce((product, value) => product * value, 1), 1 / values.length));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator, denominator) {
  return denominator ? round(numerator / denominator) : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function format(value) {
  return Number(value || 0).toFixed(3);
}
