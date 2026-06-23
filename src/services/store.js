import { id } from '../lib/id.js';
import { readJson, writeJson } from '../lib/json.js';
import { nowIso } from '../lib/time.js';
import { createDemoState } from '../demo.js';
import { buildOtlpPayload, exportOtlpTrace } from '../observability/otel.js';
import { chunkDocument, createDocument } from '../rag/chunker.js';
import { extractPdfTextWithFallback } from '../rag/pdf.js';
import { runRagInspection } from '../rag/pipeline.js';
import { redactSecrets } from '../security/redact.js';
import { IngestionWorker } from './ingestion-worker.js';
import {
  LIMITS,
  httpError,
  validateChunkCapacity,
  validateDocumentInput,
  validateEvalQuestionInput,
  validateId,
  validateProjectInput,
  validateQueryInput,
  validateSettingsInput
} from './validation.js';

const DEFAULT_SETTINGS = Object.freeze({
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
});

export class RaglensStore {
  constructor(config) {
    this.config = config;
    this.state = null;
    this.ingestionWorker = new IngestionWorker({
      processDocument: (input, context) => this.addDocumentToProject(input, context.projectId)
    });
  }

  async load() {
    const fallback = this.config.autoSeed ? createDemoState() : createEmptyState();
    this.state = normalizeState(await readJson(this.config.dataFile, fallback));
    await this.save();
    return this.snapshot();
  }

  snapshot() {
    const activeProjectId = this.activeProjectId();
    return JSON.parse(JSON.stringify({
      ...sanitizePublicState(scopedState(this.state, activeProjectId)),
      ingestionJobs: this.listIngestionJobs()
    }));
  }

  async save() {
    this.state.updatedAt = nowIso();
    await writeJson(this.config.dataFile, this.state);
  }

  async resetDemo() {
    this.state = normalizeState(createDemoState());
    this.ingestionWorker.clear();
    await this.save();
    return this.snapshot();
  }

  activeProjectId() {
    const projectIds = new Set((this.state.projects || []).map((project) => project.id));
    if (projectIds.has(this.state.activeProjectId)) {
      this.state.settings = settingsForState(this.state, this.state.activeProjectId);
      return this.state.activeProjectId;
    }

    this.state.activeProjectId = this.state.projects[0]?.id || null;
    this.state.settings = settingsForState(this.state, this.state.activeProjectId);
    return this.state.activeProjectId;
  }

  async addProject(input) {
    const validated = validateProjectInput(input, this.state);
    const createdAt = nowIso();
    const project = {
      id: id('prj'),
      ...validated,
      settings: { ...this.projectSettings() },
      createdAt,
      updatedAt: createdAt
    };

    this.state.projects.unshift(project);
    this.state.activeProjectId = project.id;
    await this.save();
    return this.snapshot();
  }

  async setActiveProject(projectId) {
    const idValue = validateId(projectId, 'project id');
    const exists = this.state.projects.some((project) => project.id === idValue);
    if (!exists) {
      return null;
    }

    this.state.activeProjectId = idValue;
    this.state.settings = this.projectSettings(idValue);
    await this.save();
    return this.snapshot();
  }

  async addDocument(input) {
    return this.addDocumentToProject(input, this.resolveProjectId(input?.projectId));
  }

  queueDocument(input) {
    return this.ingestionWorker.enqueue(input, {
      projectId: this.resolveProjectId(input?.projectId)
    });
  }

  listIngestionJobs(projectId = null) {
    return this.ingestionWorker.list(this.resolveProjectId(projectId));
  }

  getIngestionJob(jobId, projectId = null) {
    validateId(jobId, 'ingestion job id');
    return this.ingestionWorker.get(jobId, this.resolveProjectId(projectId));
  }

  async addDocumentToProject(input, projectId) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    const settings = this.projectSettings(resolvedProjectId);
    const normalizedInput = await normalizeDocumentInput(input, this.config.pdfTextExtractor);
    const validated = validateDocumentInput(normalizedInput, this.state);
    const titleRedaction = redactForSettings(validated.title, settings);
    const redaction = redactForSettings(validated.text, settings);
    const document = createDocument({
      ...validated,
      projectId: resolvedProjectId,
      title: titleRedaction.text,
      text: redaction.text,
      metadata: {
        redactions: [...titleRedaction.findings, ...redaction.findings],
        pdfExtraction: normalizedInput.metadata?.pdfExtraction || null
      }
    });
    const chunks = chunkDocument(document, {
      maxTokens: settings.chunkTokens,
      overlapTokens: settings.overlapTokens
    });
    validateChunkCapacity(this.state, chunks.length);

    this.state.documents.unshift(document);
    this.state.chunks.push(...chunks);
    await this.save();
    return {
      document: documentMetadata(document),
      chunks: chunks.map(chunkSnapshot)
    };
  }

  async deleteDocument(documentId, options = {}) {
    validateId(documentId, 'document id');
    const projectId = this.resolveProjectId(options.projectId);
    const document = this.state.documents.find((item) => item.id === documentId && item.projectId === projectId);

    if (!document) {
      return false;
    }

    this.state.documents = this.state.documents.filter((item) => item.id !== documentId);
    this.state.chunks = this.state.chunks.filter((chunk) => chunk.documentId !== documentId);

    await this.save();
    return true;
  }

  async reindexDocuments(options = {}) {
    const projectId = this.resolveProjectId(options.projectId);
    const settings = this.projectSettings(projectId);
    const projectDocuments = itemsForProject(this.state.documents, projectId);
    const otherChunks = this.state.chunks.filter((chunk) => chunk.projectId !== projectId);
    const reindexedAt = nowIso();
    const refreshedDocuments = projectDocuments.map((document) => ({
      ...document,
      status: 'indexed',
      updatedAt: reindexedAt
    }));
    const refreshedById = new Map(refreshedDocuments.map((document) => [document.id, document]));
    const chunks = refreshedDocuments.flatMap((document) =>
      chunkDocument(document, {
        maxTokens: settings.chunkTokens,
        overlapTokens: settings.overlapTokens
      })
    );

    if (otherChunks.length + chunks.length > LIMITS.chunksMax) {
      throw httpError(409, `Chunk limit reached. Limit is ${LIMITS.chunksMax} chunks.`);
    }

    this.state.documents = this.state.documents.map((document) => refreshedById.get(document.id) || document);
    this.state.chunks = [...otherChunks, ...chunks];
    await this.save();

    return {
      documents: refreshedDocuments.map(documentMetadata),
      chunks: chunks.map(chunkSnapshot),
      settings: {
        chunkTokens: settings.chunkTokens,
        overlapTokens: settings.overlapTokens
      },
      reindexedAt
    };
  }

  async runQuery(input) {
    const query = validateQueryInput(input);
    const hasInput = (key) => Object.hasOwn(input, key);
    const projectId = this.resolveProjectId(input?.projectId);
    const settings = this.projectSettings(projectId);
    const redactedQuestion = redactForSettings(query.question, settings);
    const redactedPromptTemplate = redactForSettings(query.promptTemplate, settings);
    const expected = this.findExpectedSource(redactedQuestion.text, projectId);
    const projectChunks = itemsForProject(this.state.chunks, projectId);
    const projectDocuments = itemsForProject(this.state.documents, projectId);
    const retrieveContext = typeof this.retrieveContext === 'function'
      ? (retrievalInput) => this.retrieveContext({ ...retrievalInput, projectId })
      : null;

    const inspection = await runRagInspection({
      question: redactedQuestion.text,
      chunks: projectChunks,
      retrieveContext,
      config: {
        topK: hasInput('topK') ? query.topK : settings.topK,
        maxClaims: hasInput('maxClaims') ? query.maxClaims : settings.maxClaims,
        temperature: hasInput('temperature') ? query.temperature : settings.temperature,
        model: hasInput('model') && query.model ? query.model : settings.model,
        provider: hasInput('provider') && query.provider ? query.provider : settings.provider,
        retrievalMode: hasInput('retrievalMode') ? query.retrievalMode : settings.retrievalMode,
        promptTemplate: hasInput('promptTemplate') && redactedPromptTemplate.text
          ? redactedPromptTemplate.text
          : settings.promptTemplate,
        chunkTokens: settings.chunkTokens,
        overlapTokens: settings.overlapTokens,
        promptLoggingEnabled: hasInput('promptLoggingEnabled')
          ? query.promptLoggingEnabled
          : settings.promptLoggingEnabled !== false,
        allowUnsafeProviderEgress: hasInput('allowUnsafeProviderEgress')
          ? query.allowUnsafeProviderEgress
          : false,
        rerank: hasInput('rerank') ? query.rerank : settings.rerank !== false,
        expectedSource: expected?.expectedSource,
        expectedAnswer: expected?.expectedAnswer,
        openaiCompatible: this.config.openaiCompatible,
        costRates: this.config.costRates
      }
    });
    const run = {
      id: id('run'),
      projectId,
      ...inspection
    };
    run.evidenceSnapshot = createEvidenceSnapshot(run.retrieved, projectChunks, projectDocuments);
    run.redactions = [...redactedQuestion.findings, ...redactedPromptTemplate.findings];

    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 100);
    run.observability = {
      otelExport: await exportOtlpTrace(hydrateRun(run, this.state.chunks, this.state.documents), this.config.otel)
    };
    await this.save();
    return run;
  }

  findExpectedSource(question, projectId = null) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    return this.state.evalQuestions.find(
      (item) =>
        item.projectId === resolvedProjectId &&
        item.question.trim().toLowerCase() === String(question || '').trim().toLowerCase()
    );
  }

  hydrateRun(runId, options = {}) {
    validateId(runId, 'run id');
    const projectId = this.resolveProjectId(options.projectId);
    const run = this.state.runs.find((item) => item.id === runId && item.projectId === projectId);
    if (!run) {
      return null;
    }

    const projectChunks = itemsForProject(this.state.chunks, projectId);
    const projectDocuments = itemsForProject(this.state.documents, projectId);
    return hydrateRun(run, projectChunks, projectDocuments);
  }

  listRuns() {
    const projectId = this.activeProjectId();
    return itemsForProject(this.state.runs, projectId).map((run) => summarizeRun(run));
  }

  compareRuns(leftId, rightId, options = {}) {
    validateId(leftId, 'left run id');
    validateId(rightId, 'right run id');
    const projectId = this.resolveProjectId(options.projectId);
    const left = this.hydrateRun(leftId, { projectId });
    const right = this.hydrateRun(rightId, { projectId });

    if (!left || !right) {
      return null;
    }

    return {
      left: summarizeRunForCompare(left),
      right: summarizeRunForCompare(right),
      deltas: compareMetricDeltas(left.evaluation.metrics, right.evaluation.metrics),
      configDiffs: compareConfig(left.config, right.config),
      retrieval: compareRetrieval(left.retrieved, right.retrieved),
      answers: compareAnswers(left, right),
      warnings: compareWarnings(left.warnings || [], right.warnings || [])
    };
  }

  async addEvalQuestion(input) {
    const validated = validateEvalQuestionInput(input, this.state);
    const projectId = this.resolveProjectId(input?.projectId);
    const settings = this.projectSettings(projectId);
    const redactedQuestion = redactForSettings(validated.question, settings);
    const redactedExpectedSource = redactForSettings(validated.expectedSource, settings);
    const redactedExpectedAnswer = redactForSettings(validated.expectedAnswer, settings);
    const normalizedQuestion = redactedQuestion.text.trim().toLowerCase();
    const existing = this.state.evalQuestions.find(
      (item) => item.projectId === projectId && item.question.trim().toLowerCase() === normalizedQuestion
    );

    if (existing) {
      existing.expectedSource = redactedExpectedSource.text;
      existing.expectedAnswer = redactedExpectedAnswer.text;
      existing.updatedAt = nowIso();
      existing.redactions = [
        ...redactedQuestion.findings,
        ...redactedExpectedSource.findings,
        ...redactedExpectedAnswer.findings
      ];
      await this.save();
      return existing;
    }

    const evalQuestion = {
      id: id('eval'),
      projectId,
      question: redactedQuestion.text,
      expectedSource: redactedExpectedSource.text,
      expectedAnswer: redactedExpectedAnswer.text,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      redactions: [
        ...redactedQuestion.findings,
        ...redactedExpectedSource.findings,
        ...redactedExpectedAnswer.findings
      ]
    };

    this.state.evalQuestions.unshift(evalQuestion);
    await this.save();
    return evalQuestion;
  }

  async deleteEvalQuestion(evalQuestionId, options = {}) {
    validateId(evalQuestionId, 'eval question id');
    const projectId = this.resolveProjectId(options.projectId);
    const exists = this.state.evalQuestions.some((item) => item.id === evalQuestionId && item.projectId === projectId);

    if (!exists) {
      return false;
    }

    this.state.evalQuestions = this.state.evalQuestions.filter((item) => item.id !== evalQuestionId);

    await this.save();
    return true;
  }

  async updateSettings(input) {
    const projectId = this.resolveProjectId(input?.projectId);
    const currentSettings = this.projectSettings(projectId);
    const candidate = {
      ...currentSettings,
      ...input
    };
    candidate.promptTemplate = redactForSettings(candidate.promptTemplate, candidate).text;
    const settings = {
      ...currentSettings,
      ...validateSettingsInput(candidate)
    };
    this.setProjectSettings(projectId, settings);
    await this.save();
    return settings;
  }

  async addFeedback(runId, input) {
    validateId(runId, 'run id');
    const projectId = this.resolveProjectId(input?.projectId);
    const settings = this.projectSettings(projectId);
    const run = this.state.runs.find((item) => item.id === runId && item.projectId === projectId);
    if (!run) {
      return null;
    }

    const rawNote = String(input.note || '').trim().slice(0, 1_000);
    const rawExpectedAnswer = String(input.expectedAnswer || '').trim().slice(0, 4_000);
    const noteRedaction = redactForSettings(rawNote, settings);
    const expectedAnswerRedaction = redactForSettings(rawExpectedAnswer, settings);
    const feedback = {
      id: id('fbk'),
      rating: input.rating === 'down' ? 'down' : 'up',
      note: noteRedaction.text,
      expectedAnswer: expectedAnswerRedaction.text,
      redactions: [...noteRedaction.findings, ...expectedAnswerRedaction.findings],
      createdAt: nowIso()
    };
    run.feedback = [feedback, ...(run.feedback || [])].slice(0, 20);
    await this.save();
    return feedback;
  }

  exportOtelRun(runId, options = {}) {
    const run = this.hydrateRun(runId, options);
    if (!run) {
      return null;
    }

    return buildOtlpPayload(run, {
      serviceName: this.config.otel?.serviceName || 'raglens',
      includeContent: this.config.otel?.includeContent === true
    });
  }

  exportRunBundle(runId, options = {}) {
    const run = this.hydrateRun(runId, options);
    if (!run) {
      return null;
    }

    const project = this.state.projects.find((item) => item.id === run.projectId) || null;
    const evidence = evidenceFromRun(run);

    return {
      schema: 'raglens.run-bundle.v1',
      exportedAt: nowIso(),
      project: project
        ? {
            id: project.id,
            name: project.name,
            description: project.description || ''
          }
        : null,
      run: sanitizeRunForBundle(run),
      evidence,
      review: {
        question: run.question,
        answer: run.answer?.text || '',
        failureSummary: run.evaluation?.failureSummary || '',
        metrics: run.evaluation?.metrics || {},
        warningTypes: (run.warnings || []).map((warning) => warning.type)
      }
    };
  }

  resolveProjectId(projectId = null) {
    if (projectId === null || projectId === undefined || projectId === '') {
      return this.activeProjectId();
    }
    const idValue = validateId(projectId, 'project id');
    const exists = this.state.projects.some((project) => project.id === idValue);
    if (!exists) {
      throw httpError(404, 'Project not found.');
    }
    return idValue;
  }

  projectSettings(projectId = null) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    return settingsForState(this.state, resolvedProjectId);
  }

  setProjectSettings(projectId, settings) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    return setProjectSettingsForState(this.state, resolvedProjectId, settings);
  }
}

export function createEmptyState() {
  const createdAt = nowIso();
  const settings = defaultSettings();
  const project = {
    id: id('prj'),
    name: 'RAGLens workspace',
    description: 'Local RAG inspection workspace.',
    settings: { ...settings },
    createdAt,
    updatedAt: createdAt
  };

  return {
    version: 1,
    createdAt,
    updatedAt: createdAt,
    activeProjectId: project.id,
    projects: [project],
    documents: [],
    chunks: [],
    runs: [],
    evalQuestions: [],
    settings
  };
}

export function hydrateRun(run, chunks, documents = []) {
  const snapshotChunks = run.evidenceSnapshot?.chunks || [];
  const snapshotDocuments = run.evidenceSnapshot?.documents || [];
  const byChunkId = new Map([
    ...snapshotChunks.map((chunk) => [chunk.id, chunk]),
    ...chunks.map((chunk) => [chunk.id, chunk])
  ]);
  const byDocId = new Map([
    ...snapshotDocuments.map((document) => [document.id, document]),
    ...documents.map((document) => [document.id, document])
  ]);

  return {
    ...run,
    retrieved: run.retrieved.map((item) => {
      const chunk = byChunkId.get(item.chunkId);
      return {
        ...item,
        chunk,
        document: chunk ? byDocId.get(chunk.documentId) : null
      };
    })
  };
}

function summarizeRun(run) {
  return {
    id: run.id,
    question: run.question,
    createdAt: run.createdAt,
    latencyMs: run.latencyMs,
    warnings: run.warnings,
    metrics: run.evaluation.metrics,
    config: run.config,
    topChunkId: run.retrieved[0]?.chunkId || null
  };
}

function summarizeRunForCompare(run) {
  return {
    id: run.id,
    question: run.question,
    createdAt: run.createdAt,
    latencyMs: run.latencyMs,
    config: run.config,
    metrics: run.evaluation?.metrics || {},
    warningTypes: (run.warnings || []).map((warning) => warning.type)
  };
}

function createEvidenceSnapshot(retrieved, chunks, documents) {
  const byChunkId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const byDocId = new Map(documents.map((document) => [document.id, document]));
  const snapshotChunks = uniqueBy(
    (retrieved || [])
      .map((item) => byChunkId.get(item.chunkId))
      .filter(Boolean)
      .map(chunkSnapshot),
    'id'
  );
  const snapshotDocuments = uniqueBy(
    snapshotChunks
      .map((chunk) => byDocId.get(chunk.documentId))
      .filter(Boolean)
      .map(documentMetadata),
    'id'
  );

  return {
    documents: snapshotDocuments,
    chunks: snapshotChunks
  };
}

function sanitizeRunForBundle(run) {
  const { evidenceSnapshot, retrieved, prompt, ...rest } = run;
  return {
    ...rest,
    prompt: prompt
      ? {
          logged: true,
          omitted: 'Full prompt text is omitted from portable run bundles.'
        }
      : null,
    retrieved: (retrieved || []).map(sanitizeRetrievedItem)
  };
}

function sanitizeRetrievedItem(item) {
  const { document, chunk, ...rest } = item;
  return {
    ...rest,
    document: document ? documentMetadata(document) : null,
    chunk: chunk ? chunkSnapshot(chunk) : null
  };
}

function evidenceFromRun(run) {
  return {
    documents: uniqueBy(
      (run.retrieved || [])
        .map((item) => item.document)
        .filter(Boolean)
        .map(documentMetadata),
      'id'
    ),
    chunks: uniqueBy(
      (run.retrieved || [])
        .map((item) => item.chunk)
        .filter(Boolean)
        .map(chunkSnapshot),
      'id'
    )
  };
}

function documentMetadata(document) {
  return {
    id: document.id,
    projectId: document.projectId || null,
    title: document.title,
    sourceType: document.sourceType,
    checksum: document.checksum,
    wordCount: document.wordCount,
    status: document.status,
    createdAt: document.createdAt
  };
}

function projectMetadata(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function chunkSnapshot(chunk) {
  return {
    id: chunk.id,
    projectId: chunk.projectId || null,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    label: chunk.label,
    section: chunk.section,
    page: chunk.page,
    tokenCount: chunk.tokenCount,
    embeddingModel: chunk.embeddingModel,
    embeddedAt: chunk.embeddedAt,
    createdAt: chunk.createdAt,
    text: chunk.text
  };
}

function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [item[key], item])).values()];
}

function itemsForProject(items, projectId) {
  return items.filter((item) => item.projectId === projectId);
}

function redactForSettings(value, settings) {
  return settings.redactionEnabled === false
    ? { text: value, findings: [] }
    : redactSecrets(value);
}

function compareMetricDeltas(leftMetrics, rightMetrics) {
  const keys = new Set([...Object.keys(leftMetrics), ...Object.keys(rightMetrics)]);
  return [...keys].map((key) => ({
    key,
    left: leftMetrics[key] || 0,
    right: rightMetrics[key] || 0,
    delta: Number(((rightMetrics[key] || 0) - (leftMetrics[key] || 0)).toFixed(3))
  }));
}

function compareConfig(leftConfig = {}, rightConfig = {}) {
  const keys = [
    'provider',
    'model',
    'mode',
    'retrievalMode',
    'rerank',
    'topK',
    'maxClaims',
    'temperature',
    'promptVersion',
    'promptTemplateFingerprint',
    'promptTemplatePreview',
    'chunkTokens',
    'overlapTokens',
    'indexedChunks',
    'avgChunkTokens'
  ];
  return keys.map((key) => ({
    key,
    left: normalizeComparableValue(leftConfig[key]),
    right: normalizeComparableValue(rightConfig[key]),
    changed: normalizeComparableValue(leftConfig[key]) !== normalizeComparableValue(rightConfig[key])
  }));
}

function compareRetrieval(leftRetrieved = [], rightRetrieved = []) {
  const leftByChunk = new Map(leftRetrieved.map((item) => [item.chunkId, item]));
  const rightByChunk = new Map(rightRetrieved.map((item) => [item.chunkId, item]));
  const sharedChunkIds = [...leftByChunk.keys()].filter((chunkId) => rightByChunk.has(chunkId));
  const unionSize = new Set([...leftByChunk.keys(), ...rightByChunk.keys()]).size;
  const stableEvidence = compareStableEvidence(leftRetrieved, rightRetrieved);

  return {
    overlapCount: sharedChunkIds.length,
    overlapRatio: unionSize ? Number((sharedChunkIds.length / unionSize).toFixed(3)) : 0,
    sourceOverlapCount: stableEvidence.overlapCount,
    sourceOverlapRatio: stableEvidence.overlapRatio,
    topSourceChanged: stableEvidence.topSourceChanged,
    sharedSources: stableEvidence.sharedSources,
    leftOnlySources: stableEvidence.leftOnlySources,
    rightOnlySources: stableEvidence.rightOnlySources,
    topChunkChanged: (leftRetrieved[0]?.chunkId || null) !== (rightRetrieved[0]?.chunkId || null),
    shared: sharedChunkIds.map((chunkId) => {
      const left = leftByChunk.get(chunkId);
      const right = rightByChunk.get(chunkId);
      return {
        ...summarizeRetrievedForCompare(left),
        leftRank: left.rank,
        rightRank: right.rank,
        leftScore: left.score,
        rightScore: right.score,
        rankDelta: Number((right.rank - left.rank).toFixed(3)),
        scoreDelta: Number(((right.score || 0) - (left.score || 0)).toFixed(3))
      };
    }),
    leftOnly: leftRetrieved
      .filter((item) => !rightByChunk.has(item.chunkId))
      .map(summarizeRetrievedForCompare),
    rightOnly: rightRetrieved
      .filter((item) => !leftByChunk.has(item.chunkId))
      .map(summarizeRetrievedForCompare)
  };
}

function compareStableEvidence(leftRetrieved = [], rightRetrieved = []) {
  const leftBySource = groupRetrievedByStableSource(leftRetrieved);
  const rightBySource = groupRetrievedByStableSource(rightRetrieved);
  const sharedKeys = [...leftBySource.keys()].filter((key) => rightBySource.has(key));
  const unionSize = new Set([...leftBySource.keys(), ...rightBySource.keys()]).size;

  return {
    overlapCount: sharedKeys.length,
    overlapRatio: unionSize ? Number((sharedKeys.length / unionSize).toFixed(3)) : 0,
    topSourceChanged: (stableSourceKey(leftRetrieved[0]) || null) !== (stableSourceKey(rightRetrieved[0]) || null),
    sharedSources: sharedKeys.map((key) => summarizeSharedSource(key, leftBySource.get(key), rightBySource.get(key))),
    leftOnlySources: [...leftBySource.entries()]
      .filter(([key]) => !rightBySource.has(key))
      .map(([, group]) => summarizeSourceGroup(group)),
    rightOnlySources: [...rightBySource.entries()]
      .filter(([key]) => !leftBySource.has(key))
      .map(([, group]) => summarizeSourceGroup(group))
  };
}

function groupRetrievedByStableSource(retrieved = []) {
  const groups = new Map();
  for (const item of retrieved) {
    const key = stableSourceKey(item);
    if (!key) {
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      existing.best = compareRetrievedScore(item, existing.best) > 0 ? item : existing.best;
    } else {
      groups.set(key, {
        key,
        items: [item],
        best: item
      });
    }
  }
  return groups;
}

function summarizeSharedSource(key, leftGroup, rightGroup) {
  const left = leftGroup.best;
  const right = rightGroup.best;
  return {
    key,
    ...sourceSummary(left),
    leftRank: left.rank,
    rightRank: right.rank,
    leftScore: left.score,
    rightScore: right.score,
    leftChunkCount: leftGroup.items.length,
    rightChunkCount: rightGroup.items.length,
    rankDelta: Number((right.rank - left.rank).toFixed(3)),
    scoreDelta: Number(((right.score || 0) - (left.score || 0)).toFixed(3))
  };
}

function summarizeSourceGroup(group) {
  return {
    key: group.key,
    ...sourceSummary(group.best),
    rank: group.best.rank,
    score: group.best.score,
    chunkCount: group.items.length
  };
}

function sourceSummary(item) {
  return {
    documentTitle: item.document?.title || item.chunk?.documentTitle || 'Unknown document',
    documentChecksum: item.document?.checksum || null,
    documentId: item.document?.id || item.chunk?.documentId || null,
    section: item.chunk?.section || '',
    page: item.chunk?.page || null,
    textFingerprint: textFingerprint(item.chunk?.text || ''),
    text: truncateText(item.chunk?.text || '', 320)
  };
}

function stableSourceKey(item) {
  if (!item) {
    return '';
  }
  const documentKey = [
    item.document?.checksum,
    item.document?.title || item.chunk?.documentTitle,
    item.chunk?.documentId
  ].filter(Boolean).map(stableKeyPart).join(':');
  const sectionKey = stableKeyPart(item.chunk?.section || `page-${item.chunk?.page || 'unknown'}`);
  return documentKey ? `${documentKey}::${sectionKey}` : '';
}

function compareRetrievedScore(left, right) {
  const leftScore = Number(left?.score || 0);
  const rightScore = Number(right?.score || 0);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  return Number(right?.rank || 0) - Number(left?.rank || 0);
}

function compareAnswers(left, right) {
  return {
    leftText: left.answer?.text || '',
    rightText: right.answer?.text || '',
    leftClaimCount: left.evaluation?.claims?.length || 0,
    rightClaimCount: right.evaluation?.claims?.length || 0,
    faithfulnessDelta: metricDelta(left, right, 'faithfulness'),
    citationCoverageDelta: metricDelta(left, right, 'citationCoverage'),
    latencyDeltaMs: Number(((right.latencyMs || 0) - (left.latencyMs || 0)).toFixed(3)),
    costDeltaUsd: Number((((right.usage?.estimatedCostUsd || 0) - (left.usage?.estimatedCostUsd || 0))).toFixed(8))
  };
}

function compareWarnings(leftWarnings = [], rightWarnings = []) {
  const leftTypes = new Set(leftWarnings.map((warning) => warning.type));
  const rightTypes = new Set(rightWarnings.map((warning) => warning.type));

  return {
    leftCount: leftWarnings.length,
    rightCount: rightWarnings.length,
    commonTypes: [...leftTypes].filter((type) => rightTypes.has(type)),
    resolvedTypes: [...leftTypes].filter((type) => !rightTypes.has(type)),
    addedTypes: [...rightTypes].filter((type) => !leftTypes.has(type)),
    leftOnly: leftWarnings.filter((warning) => !rightTypes.has(warning.type)),
    rightOnly: rightWarnings.filter((warning) => !leftTypes.has(warning.type))
  };
}

function summarizeRetrievedForCompare(item) {
  return {
    chunkId: item.chunkId,
    rank: item.rank,
    score: item.score,
    similarityScore: item.similarityScore,
    rerankScore: item.rerankScore,
    coverage: item.coverage,
    label: item.chunk?.label || item.chunkId,
    documentTitle: item.document?.title || 'Unknown document',
    section: item.chunk?.section || '',
    page: item.chunk?.page || null,
    text: truncateText(item.chunk?.text || '', 420)
  };
}

function stableKeyPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function textFingerprint(value) {
  const text = truncateText(value, 180).toLowerCase();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return `txt_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

function metricDelta(left, right, key) {
  return Number((((right.evaluation?.metrics?.[key] || 0) - (left.evaluation?.metrics?.[key] || 0))).toFixed(3));
}

function normalizeComparableValue(value) {
  if (value === undefined || value === null || value === '') {
    return 'default';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  return String(value);
}

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}...` : text;
}

async function normalizeDocumentInput(input, pdfTextExtractor = {}) {
  if (input.sourceType === 'pdf' && input.base64) {
    const extracted = await extractPdfTextWithFallback(decodePdfBase64(input.base64), pdfTextExtractor);
    return {
      ...input,
      text: extracted.text,
      metadata: {
        ...(input.metadata || {}),
        pdfExtraction: extracted.metadata
      }
    };
  }

  return input;
}

function decodePdfBase64(value) {
  const base64 = String(value || '').trim();
  if (!base64) {
    throw httpError(400, 'PDF base64 payload is required.');
  }
  if (base64.length > Math.ceil((LIMITS.pdfBytesMax * 4) / 3) + 8) {
    throw httpError(413, `PDF file is too large. Limit is ${LIMITS.pdfBytesMax} bytes.`);
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > LIMITS.pdfBytesMax) {
    throw httpError(413, `PDF file is too large. Limit is ${LIMITS.pdfBytesMax} bytes.`);
  }

  const header = buffer.subarray(0, 1024).toString('latin1');
  if (!header.includes('%PDF')) {
    throw httpError(400, 'PDF payload must start with a valid PDF header.');
  }

  return buffer;
}

export function normalizeState(state) {
  const empty = createEmptyState();
  const topLevelSettings = normalizeSettings(state.settings || empty.settings);
  const normalized = {
    ...empty,
    ...state,
    settings: topLevelSettings
  };

  const hasStoredProjects = Array.isArray(state.projects) && state.projects.length;
  normalized.projects = Array.isArray(normalized.projects) && normalized.projects.length
    ? normalized.projects
    : empty.projects;

  const firstProject = normalized.projects[0];
  const fallbackProjectId = normalized.activeProjectId || firstProject.id;
  const projectIds = new Set(normalized.projects.map((project) => project.id));

  normalized.activeProjectId = projectIds.has(fallbackProjectId) ? fallbackProjectId : firstProject.id;
  normalized.projects = normalized.projects.map((project) => {
    const hasProjectSettings = hasStoredProjects && Object.hasOwn(project, 'settings');
    return {
      ...project,
      settings: normalizeSettings(hasProjectSettings
        ? {
            ...topLevelSettings,
            ...(project.settings || {})
          }
        : topLevelSettings)
    };
  });
  normalized.settings = settingsForState(normalized, normalized.activeProjectId);
  normalized.documents = (normalized.documents || []).map((document) => ({
    ...document,
    projectId: projectIds.has(document.projectId) ? document.projectId : normalized.activeProjectId
  }));
  normalized.chunks = (normalized.chunks || []).map((chunk) => {
    const document = normalized.documents.find((item) => item.id === chunk.documentId);
    return {
      ...chunk,
      projectId: projectIds.has(chunk.projectId) ? chunk.projectId : document?.projectId || normalized.activeProjectId
    };
  });
  normalized.runs = (normalized.runs || []).map((run) => ({
    ...run,
    projectId: projectIds.has(run.projectId) ? run.projectId : normalized.activeProjectId
  }));
  normalized.evalQuestions = (normalized.evalQuestions || []).map((item) => ({
    ...item,
    projectId: projectIds.has(item.projectId) ? item.projectId : normalized.activeProjectId
  }));

  return normalized;
}

function scopedState(state, projectId) {
  return {
    ...state,
    settings: settingsForState(state, projectId),
    documents: itemsForProject(state.documents, projectId),
    chunks: itemsForProject(state.chunks, projectId),
    runs: itemsForProject(state.runs, projectId),
    evalQuestions: itemsForProject(state.evalQuestions, projectId),
    activeProjectId: projectId
  };
}

function sanitizePublicState(state) {
  return {
    ...state,
    projects: state.projects.map(projectMetadata),
    documents: state.documents.map(documentMetadata),
    chunks: state.chunks.map(chunkSnapshot)
  };
}

function defaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

function normalizeSettings(settings = {}) {
  return validateSettingsInput({
    ...defaultSettings(),
    ...(settings || {})
  });
}

function settingsForState(state, projectId) {
  const fallback = normalizeSettings(state.settings || {});
  const project = (state.projects || []).find((item) => item.id === projectId);
  if (!project) {
    return fallback;
  }

  project.settings = normalizeSettings({
    ...fallback,
    ...(project.settings || {})
  });
  if (project.id === state.activeProjectId) {
    state.settings = project.settings;
  }
  return project.settings;
}

function setProjectSettingsForState(state, projectId, settings) {
  const project = (state.projects || []).find((item) => item.id === projectId);
  if (!project) {
    throw httpError(404, 'Project not found.');
  }

  project.settings = normalizeSettings(settings);
  if (project.id === state.activeProjectId) {
    state.settings = project.settings;
  }
  return project.settings;
}
