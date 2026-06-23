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
    text
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
    rerank: input.rerank !== false
  };
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
