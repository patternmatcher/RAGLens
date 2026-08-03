const SOURCE_TYPES = new Set(['markdown', 'text', 'csv', 'json', 'log', 'pdf']);

export const LIMITS = {
  documentTitleChars: 160,
  projectNameChars: 120,
  projectDescriptionChars: 400,
  documentTextChars: 200_000,
  pdfBytesMax: 1_000_000,
  questionChars: 2_000,
  topKMax: 20,
  maxClaimsMax: 8,
  documentsMax: 200,
  chunksMax: 6_000,
  evalQuestionsMax: 200,
  projectsMax: 50,
  expectedSourceChars: 160,
  expectedAnswerChars: 4_000
};

const DOCUMENT_METADATA_FIELDS = new Set([
  'collection',
  'department',
  'version',
  'effectiveDate',
  'sensitivity',
  'sourceUri'
]);

export function validateDocumentInput(input, state) {
  const title = cleanString(input.title).slice(0, LIMITS.documentTitleChars);
  const sourceType = SOURCE_TYPES.has(input.sourceType) ? input.sourceType : 'text';
  const text = cleanString(input.text);

  if (!title) {
    throw httpError(400, 'Document title is required.');
  }
  if (!text) {
    throw httpError(400, 'Document text is required.');
  }
  if (text.length > LIMITS.documentTextChars) {
    throw httpError(413, `Document text is too large. Limit is ${LIMITS.documentTextChars} characters.`);
  }
  if (state.documents.length >= LIMITS.documentsMax) {
    throw httpError(409, `Document limit reached. Limit is ${LIMITS.documentsMax} documents.`);
  }

  return {
    title,
    sourceType,
    text,
    metadata: validateDocumentMetadata(input.metadata)
  };
}

export function validateChunkCapacity(state, newChunkCount) {
  if (state.chunks.length + newChunkCount > LIMITS.chunksMax) {
    throw httpError(409, `Chunk limit reached. Limit is ${LIMITS.chunksMax} chunks.`);
  }
}

export function validateQueryInput(input) {
  const question = cleanString(input.question);

  if (!question) {
    throw httpError(400, 'Question is required.');
  }
  if (question.length > LIMITS.questionChars) {
    throw httpError(413, `Question is too large. Limit is ${LIMITS.questionChars} characters.`);
  }

  return {
    question,
    topK: clampInt(input.topK, 1, LIMITS.topKMax, 6),
    maxClaims: clampInt(input.maxClaims, 1, LIMITS.maxClaimsMax, 4),
    temperature: clampNumber(input.temperature, 0, 1, 0),
    model: cleanString(input.model).slice(0, 80),
    provider: cleanString(input.provider).slice(0, 40),
    retrievalMode: ['keyword', 'vector', 'hybrid'].includes(input.retrievalMode) ? input.retrievalMode : 'hybrid',
    promptTemplate: cleanString(input.promptTemplate).slice(0, 4_000),
    promptLoggingEnabled: input.promptLoggingEnabled !== false,
    allowUnsafeProviderEgress: input.allowUnsafeProviderEgress === true,
    rerank: input.rerank !== false,
    candidateDepth: clampInt(input.candidateDepth, 1, 100, 24),
    parentContext: input.parentContext === true,
    parentContextMaxTokens: clampInt(input.parentContextMaxTokens, 200, 8_000, 1_200),
    metadataFilter: validateMetadataFilter(input.metadataFilter)
  };
}

export function validateMetadataFilter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return compactObject({
    documentIds: stringList(value.documentIds, 50, 120),
    sourceTypes: stringList(value.sourceTypes, 10, 24).filter((item) => SOURCE_TYPES.has(item)),
    collections: stringList(value.collections, 20, 80),
    departments: stringList(value.departments, 20, 80),
    versions: stringList(value.versions, 20, 80),
    tags: stringList(value.tags, 30, 80),
    sensitivities: stringList(value.sensitivities, 10, 24),
    effectiveAfter: canonicalDate(value.effectiveAfter, 'effectiveAfter'),
    effectiveBefore: canonicalDate(value.effectiveBefore, 'effectiveBefore'),
    pageStart: nullablePositiveInt(value.pageStart),
    pageEnd: nullablePositiveInt(value.pageEnd)
  });
}

function validateDocumentMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const metadata = {};
  for (const field of DOCUMENT_METADATA_FIELDS) {
    if (field === 'effectiveDate') continue;
    const clean = cleanString(value[field]).slice(0, field === 'sourceUri' ? 500 : 120);
    if (clean) metadata[field] = clean;
  }
  const effectiveDate = canonicalDate(value.effectiveDate, 'metadata.effectiveDate');
  if (effectiveDate) metadata.effectiveDate = effectiveDate;
  const tags = stringList(value.tags, 30, 80);
  if (tags.length) metadata.tags = tags;
  return metadata;
}

function canonicalDate(value, label) {
  const date = cleanString(value);
  if (!date) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw httpError(400, `${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError(400, `${label} must be a valid calendar date.`);
  }
  return date;
}

function stringList(value, maxItems, maxLength) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(items.map((item) => cleanString(item).slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function nullablePositiveInt(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && (!Array.isArray(item) || item.length)));
}

export function validateSettingsInput(input) {
  return {
    topK: clampInt(input.topK, 1, LIMITS.topKMax, 6),
    maxClaims: clampInt(input.maxClaims, 1, LIMITS.maxClaimsMax, 4),
    chunkTokens: clampInt(input.chunkTokens, 40, 2_000, 120),
    overlapTokens: clampInt(input.overlapTokens, 0, 500, 24),
    temperature: clampNumber(input.temperature, 0, 1, 0),
    provider: cleanString(input.provider || 'local').slice(0, 40),
    model: cleanString(input.model || 'local-extractive-v1').slice(0, 80),
    retrievalMode: ['keyword', 'vector', 'hybrid'].includes(input.retrievalMode) ? input.retrievalMode : 'hybrid',
    promptTemplate: cleanString(input.promptTemplate).slice(0, 4_000),
    promptLoggingEnabled: input.promptLoggingEnabled !== false,
    redactionEnabled: input.redactionEnabled !== false,
    rerank: input.rerank !== false
  };
}

export function validateEvalQuestionInput(input, state) {
  const question = cleanString(input.question);
  const expectedSource = cleanString(input.expectedSource).slice(0, LIMITS.expectedSourceChars);
  const expectedAnswer = cleanString(input.expectedAnswer).slice(0, LIMITS.expectedAnswerChars);

  if (!question) {
    throw httpError(400, 'Eval question is required.');
  }
  if (question.length > LIMITS.questionChars) {
    throw httpError(413, `Eval question is too large. Limit is ${LIMITS.questionChars} characters.`);
  }
  if (!expectedSource) {
    throw httpError(400, 'Expected source is required.');
  }
  if (state.evalQuestions.length >= LIMITS.evalQuestionsMax) {
    throw httpError(409, `Eval question limit reached. Limit is ${LIMITS.evalQuestionsMax} questions.`);
  }

  return {
    question,
    expectedSource,
    expectedAnswer
  };
}

export function validateProjectInput(input, state) {
  const name = cleanString(input.name).slice(0, LIMITS.projectNameChars);
  const description = cleanString(input.description).slice(0, LIMITS.projectDescriptionChars);

  if (!name) {
    throw httpError(400, 'Project name is required.');
  }
  if (state.projects.length >= LIMITS.projectsMax) {
    throw httpError(409, `Project limit reached. Limit is ${LIMITS.projectsMax} projects.`);
  }

  return {
    name,
    description
  };
}

export function validateId(value, label = 'id') {
  const id = cleanString(value);
  if (!/^[a-z]+_[a-f0-9]{12}$/i.test(id)) {
    throw httpError(400, `Invalid ${label}.`);
  }
  return id;
}

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanString(value) {
  return String(value || '').replace(/\u0000/g, '').trim();
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
