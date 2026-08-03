import { nowIso } from '../lib/time.js';
import { createDemoState } from '../demo.js';
import { embedText } from '../rag/embedding.js';
import { EmbeddingCache } from '../rag/embedding-provider.js';
import { expandParentContext } from '../rag/parent-context.js';
import { jaccard, uniqueTerms } from '../rag/tokenize.js';
import { createEmptyState, normalizeState, RaglensStore } from './store.js';
import { postgresStatements } from './postgres-statements.js';

export class PostgresRaglensStore extends RaglensStore {
  constructor(config, options = {}) {
    super(config);
    this.pool = options.pool || null;
    this.poolFactory = options.poolFactory || createPgPool;
  }

  async load() {
    this.pool ||= await this.poolFactory(this.config.postgres);
    await assertPostgresSchema(this.pool);

    const loaded = await loadStateFromPostgres(this.pool);
    this.state = loaded || normalizeState(this.config.autoSeed ? createDemoState() : createEmptyState());
    this.embeddingCache = new EmbeddingCache(this.state.embeddingCache);
    const refreshed = await this.refreshEmbeddingProfiles();

    if (!loaded || refreshed) {
      await this.save();
    }

    return this.snapshot();
  }

  async save() {
    this.pool ||= await this.poolFactory(this.config.postgres);
    this.state.embeddingCache = this.embeddingCache.toJSON();
    this.state.updatedAt = nowIso();
    await syncStateToPostgres(this.pool, this.state);
  }

  async close() {
    await this.pool?.end?.();
  }

  async retrieveContext(input) {
    this.pool ||= await this.poolFactory(this.config.postgres);
    return retrieveContextFromPostgres(this.pool, {
      ...input,
      chunks: (this.state.chunks || []).filter((chunk) => chunk.projectId === input.projectId)
    });
  }
}

export async function createPgPool(postgresConfig = {}) {
  if (!postgresConfig.databaseUrl) {
    throw new Error('RAGLENS_STORAGE_DRIVER=postgres requires RAGLENS_DATABASE_URL.');
  }

  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error('RAGLENS_STORAGE_DRIVER=postgres requires the optional "pg" package. Install it in the deployment image with `npm install pg`.');
  }

  const Pool = pg.Pool || pg.default?.Pool;
  if (!Pool) {
    throw new Error('The installed "pg" package did not expose Pool.');
  }

  return new Pool({
    connectionString: postgresConfig.databaseUrl,
    max: postgresConfig.poolMax || 5,
    ssl: postgresConfig.ssl || undefined
  });
}

export async function assertPostgresSchema(queryable) {
  const result = await query(queryable, postgresStatements.assertSchema());
  const row = result.rows?.[0] || {};
  const missing = ['projects', 'documents', 'chunks', 'runs', 'eval_questions', 'embedding_cache'].filter((key) => !row[key]);

  if (missing.length) {
    throw new Error(`Postgres schema is missing RAGLens tables: ${missing.join(', ')}. Apply docs/database/postgres-pgvector.sql first.`);
  }
}

export async function loadStateFromPostgres(queryable) {
  const projectRows = (await query(queryable, postgresStatements.listProjects())).rows || [];
  if (!projectRows.length) {
    return null;
  }

  const projectStates = [];
  for (const project of projectRows) {
    const result = await query(queryable, postgresStatements.loadProjectState(project.id));
    if (result.rows?.[0]) {
      projectStates.push(result.rows[0]);
    }
  }

  const activeProject = mapProject(projectRows[0]);
  const embeddingCache = (await query(queryable, postgresStatements.listEmbeddingCache(projectRows.map((project) => project.id)))).rows || [];
  const loadedState = {
    version: 1,
    createdAt: toIso(projectRows.at(-1)?.createdAt || projectRows.at(-1)?.created_at || nowIso()),
    updatedAt: nowIso(),
    activeProjectId: activeProject.id,
    projects: projectRows.map(mapProject),
    documents: projectStates.flatMap((row) => arrayValue(row.documents).map(mapDocument)),
    chunks: projectStates.flatMap((row) => arrayValue(row.chunks).map(mapChunk)),
    runs: projectStates.flatMap((row) => arrayValue(row.runs).map(mapRun)),
    evalQuestions: projectStates.flatMap((row) => arrayValue(row.evalQuestions || row.eval_questions).map(mapEvalQuestion)),
    embeddingCache: embeddingCache.map(mapEmbeddingCache),
    settings: activeProject.settings || {}
  };

  return normalizeState(loadedState);
}

export async function syncStateToPostgres(queryable, state) {
  const client = await acquireClient(queryable);
  const projects = state.projects || [];

  try {
    await client.query('BEGIN');
    await runStatement(client, postgresStatements.deleteProjectsNotIn(projects.map((project) => project.id)));

    for (const project of projects) {
      await runStatement(client, postgresStatements.insertProject({
        ...project,
        settings: project.id === state.activeProjectId ? state.settings : project.settings || {}
      }));

      const projectDocuments = (state.documents || []).filter((document) => document.projectId === project.id);
      const projectChunks = (state.chunks || []).filter((chunk) => chunk.projectId === project.id);
      const projectRuns = (state.runs || []).filter((run) => run.projectId === project.id);
      const projectEvalQuestions = (state.evalQuestions || []).filter((item) => item.projectId === project.id);
      const feedback = projectRuns.flatMap((run) => (run.feedback || []).map((item) => ({ runId: run.id, item })));
      const projectEmbeddingCache = (state.embeddingCache || []).filter((entry) => entry.projectId === project.id);

      await runStatement(client, postgresStatements.deleteStaleDocuments(project.id, projectDocuments.map((document) => document.id)));
      await runStatement(client, postgresStatements.deleteStaleQueryRuns(project.id, projectRuns.map((run) => run.id)));
      await runStatement(client, postgresStatements.deleteStaleEvalQuestions(project.id, projectEvalQuestions.map((item) => item.id)));
      await runStatement(client, postgresStatements.deleteStaleFeedback(project.id, feedback.map(({ item }) => item.id)));
      await runStatement(client, postgresStatements.deleteStaleEmbeddingCache(project.id, projectEmbeddingCache.map((entry) => entry.key)));

      for (const document of projectDocuments) {
        await runStatement(client, postgresStatements.insertDocument(document));
      }
      for (const chunk of projectChunks) {
        await runStatement(client, postgresStatements.insertChunk(chunk));
      }
      for (const run of projectRuns) {
        await runStatement(client, postgresStatements.insertQueryRun(run));
        for (const retrieved of run.retrieved || []) {
          await runStatement(client, postgresStatements.insertRetrievedChunk(run.id, retrieved));
        }
      }
      for (const { runId, item } of feedback) {
        await runStatement(client, postgresStatements.insertFeedback(project.id, runId, item));
      }
      for (const evalQuestion of projectEvalQuestions) {
        await runStatement(client, postgresStatements.upsertEvalQuestion(evalQuestion));
      }
      for (const entry of projectEmbeddingCache) {
        await runStatement(client, postgresStatements.insertEmbeddingCache(entry));
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

export async function retrieveContextFromPostgres(queryable, options = {}) {
  const question = String(options.question || '');
  const queryVariants = options.queryVariants?.length ? options.queryVariants : [question];
  const queryTerms = uniqueTerms(queryVariants.join(' '));

  if (!options.projectId || !queryTerms.length) {
    return {
      queryTerms,
      results: [],
      stats: {
        indexedChunks: 0,
        avgChunkTokens: 0,
        mode: options.retrievalMode || 'hybrid',
        rerank: options.rerank !== false,
        source: 'postgres-pgvector'
      }
    };
  }

  const queryEmbeddings = options.queryEmbeddings?.length === queryVariants.length
    ? options.queryEmbeddings
    : queryVariants.map(embedText);
  const rowsById = new Map();
  for (let index = 0; index < queryVariants.length; index += 1) {
    const statement = postgresStatements.searchChunksByVector(options.projectId, uniqueTerms(queryVariants[index]), queryEmbeddings[index], options);
    const rows = (await query(queryable, statement)).rows || [];
    for (const row of rows) {
      const current = rowsById.get(row.id);
      if (!current || numberValue(row.rerankScore ?? row.rerank_score) > numberValue(current.rerankScore ?? current.rerank_score)) {
        rowsById.set(row.id, row);
      }
    }
  }
  const candidates = [...rowsById.values()].map(mapSearchResult)
    .sort((left, right) => right.rerankScore - left.rerankScore || left.chunk.id.localeCompare(right.chunk.id));
  const topK = Math.min(Math.max(Number(options.topK || 6), 1), 20);
  const matches = candidates.slice(0, topK).map((result, index, chosen) => finalizeSearchResult(result, index, chosen));
  const context = expandParentContext(matches, options.chunks || [], {
    enabled: options.parentContext === true,
    maxTokens: options.parentContextMaxTokens
  });
  const indexedChunks = Number([...rowsById.values()][0]?.indexedChunks ?? [...rowsById.values()][0]?.indexed_chunks ?? candidates.length);
  const avgChunkTokens = candidates.length
    ? Number((candidates.reduce((sum, item) => sum + Number(item.chunk.tokenCount || 0), 0) / candidates.length).toFixed(1))
    : 0;

  return {
    queryTerms,
    results: context.results,
    matches,
    candidates,
    stages: postgresRetrievalStages(candidates, matches, context.results, options),
    stats: {
      indexedChunks,
      eligibleChunks: indexedChunks,
      filteredOut: 0,
      avgChunkTokens,
      mode: options.retrievalMode || 'hybrid',
      rerank: options.rerank !== false,
      source: 'postgres-pgvector',
      candidateDepth: Number(options.candidateDepth || 24),
      metadataFilter: options.metadataFilter || {},
      queryVariantCount: queryVariants.length,
      parentContextEnabled: options.parentContext === true,
      parentContextChunks: context.added,
      contextTokens: context.tokenCount,
      embeddingProfileMismatches: 0
    }
  };
}

function finalizeSearchResult(result, index, chosen) {
  return {
    ...result,
    rank: index + 1,
    novelty: noveltyAgainstPrevious(result.chunk.terms, chosen.slice(0, index)),
    score: normalizeScore(result.rerankScore),
    similarityScore: Number(Math.max(0, result.vectorScore).toFixed(3))
  };
}

function postgresRetrievalStages(candidates, matches, context, options) {
  const mode = options.retrievalMode || 'hybrid';
  const stages = [];
  if (mode !== 'vector') stages.push(postgresStage('sparse', 'Postgres sparse candidates', candidates, 'lexicalScore'));
  if (mode !== 'keyword') stages.push(postgresStage('dense', 'pgvector dense candidates', candidates, 'vectorScore'));
  if (mode === 'hybrid') stages.push(postgresStage('fusion', 'Postgres hybrid fusion', candidates, 'rawScore'));
  if (options.rerank !== false) stages.push(postgresStage('rerank', 'Postgres heuristic rerank', candidates, 'rerankScore'));
  const parents = context.filter((item) => item.contextRole === 'parent');
  if (parents.length) stages.push(postgresStage('parent', 'Parent section expansion', parents, 'rerankScore'));
  stages.push(postgresStage('context', 'Prompt context selection', context, 'rerankScore'));
  return stages;
}

function postgresStage(kind, name, items, scoreKey) {
  return {
    id: kind,
    kind,
    name,
    provider: 'postgres-pgvector',
    model: kind === 'rerank' ? 'raglens-heuristic-reranker-v1' : '',
    candidateCount: items.length,
    selectedEvidenceIds: items.map((item) => item.chunk.id),
    results: items.map((item, index) => ({
      evidenceId: item.chunk.id,
      rank: index + 1,
      score: Number(item[scoreKey] || 0),
      scores: {
        lexical: Number(item.lexicalScore || 0),
        dense: Number(item.vectorScore || 0),
        fusion: Number(item.rawScore || 0),
        rerank: Number(item.rerankScore || 0),
        coverage: Number(item.coverage || 0)
      },
      contextRole: item.contextRole || 'match'
    }))
  };
}

async function acquireClient(queryable) {
  return queryable.connect ? queryable.connect() : queryable;
}

async function query(queryable, statement) {
  return queryable.query(statement.text, statement.values);
}

async function runStatement(queryable, statement) {
  return queryable.query(statement.text, statement.values);
}

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    ownerId: row.ownerId || row.owner_id || null,
    settings: row.settings || {},
    createdAt: toIso(row.createdAt || row.created_at),
    updatedAt: toIso(row.updatedAt || row.updated_at || row.createdAt || row.created_at)
  };
}

function mapDocument(row) {
  return {
    id: row.id,
    projectId: row.projectId || row.project_id,
    title: row.title,
    sourceType: row.sourceType || row.source_type || 'text',
    text: row.text || '',
    checksum: row.checksum || '',
    wordCount: Number(row.wordCount ?? row.word_count ?? 0),
    status: row.status || 'indexed',
    metadata: row.metadata || {},
    createdAt: toIso(row.createdAt || row.created_at),
    updatedAt: toIso(row.updatedAt || row.updated_at || row.createdAt || row.created_at)
  };
}

function mapChunk(row) {
  return {
    id: row.id,
    projectId: row.projectId || row.project_id,
    documentId: row.documentId || row.document_id,
    documentTitle: row.documentTitle || row.document_title || 'Untitled document',
    sourceType: row.sourceType || row.source_type || 'text',
    documentMetadata: row.documentMetadata || row.document_metadata || {},
    stableChunkId: row.stableChunkId || row.stable_chunk_id || row.id,
    index: Number(row.index ?? row.chunkIndex ?? row.chunk_index ?? 0),
    label: row.label || '',
    heading: row.heading || row.section || 'Untitled section',
    section: row.section || row.heading || 'Untitled section',
    page: row.page === null || row.page === undefined ? null : Number(row.page),
    pageStart: nullableRowNumber(row.pageStart ?? row.page_start ?? row.page),
    pageEnd: nullableRowNumber(row.pageEnd ?? row.page_end ?? row.page),
    pageNumbersExact: (row.pageNumbersExact ?? row.page_numbers_exact) === true,
    characterStart: nullableRowNumber(row.characterStart ?? row.character_start),
    characterEnd: nullableRowNumber(row.characterEnd ?? row.character_end),
    text: row.text || '',
    tokenCount: Number(row.tokenCount ?? row.token_count ?? 0),
    terms: arrayValue(row.terms),
    termCounts: row.termCounts || row.term_counts || {},
    embedding: parseVector(row.embedding),
    embeddingProvider: row.embeddingProvider || row.embedding_provider || 'local',
    embeddingModel: row.embeddingModel || row.embedding_model || 'local-hash-embedding-v1',
    embeddingDimensions: Number(row.embeddingDimensions ?? row.embedding_dimensions ?? parseVector(row.embedding).length),
    embeddedAt: toIso(row.embeddedAt || row.embedded_at),
    createdAt: toIso(row.createdAt || row.created_at || row.embeddedAt || row.embedded_at)
  };
}

function nullableRowNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapSearchResult(row) {
  return {
    chunk: mapChunk(row),
    rawScore: numberValue(row.rawScore ?? row.raw_score),
    lexicalScore: numberValue(row.lexicalScore ?? row.lexical_score),
    vectorScore: numberValue(row.vectorScore ?? row.vector_score),
    coverage: numberValue(row.coverage),
    matchedTerms: arrayValue(row.matchedTerms || row.matched_terms),
    missingTerms: arrayValue(row.missingTerms || row.missing_terms),
    rerankScore: numberValue(row.rerankScore ?? row.rerank_score)
  };
}

function mapRun(row) {
  return {
    id: row.id,
    projectId: row.projectId || row.project_id,
    question: row.question,
    config: row.config || {},
    query: row.query || {},
    queryTerms: arrayValue(row.queryTerms || row.query_terms),
    retrieved: arrayValue(row.retrieved),
    answer: row.answer || {},
    evaluation: row.evaluation || {},
    prompt: row.prompt || null,
    warnings: arrayValue(row.warnings),
    trace: arrayValue(row.trace),
    usage: row.usage || {},
    redactions: arrayValue(row.redactions),
    evidenceSnapshot: row.evidenceSnapshot || row.evidence_snapshot || { documents: [], chunks: [] },
    observability: row.observability || {},
    latencyMs: Number(row.latencyMs ?? row.latency_ms ?? 0),
    feedback: arrayValue(row.feedback).map(mapFeedback),
    createdAt: toIso(row.createdAt || row.created_at)
  };
}

function mapFeedback(row) {
  return {
    id: row.id,
    rating: row.rating === 'down' ? 'down' : 'up',
    note: row.note || '',
    expectedAnswer: row.expectedAnswer || row.expected_answer || '',
    redactions: arrayValue(row.redactions),
    createdAt: toIso(row.createdAt || row.created_at)
  };
}

function mapEvalQuestion(row) {
  return {
    id: row.id,
    projectId: row.projectId || row.project_id,
    question: row.question,
    expectedSource: row.expectedSource || row.expected_source || '',
    expectedAnswer: row.expectedAnswer || row.expected_answer || '',
    redactions: arrayValue(row.redactions),
    createdAt: toIso(row.createdAt || row.created_at),
    updatedAt: toIso(row.updatedAt || row.updated_at || row.createdAt || row.created_at)
  };
}

function mapEmbeddingCache(row) {
  const embedding = parseVector(row.embedding);
  return {
    key: row.key || row.cache_key,
    projectId: row.projectId || row.project_id,
    provider: row.provider,
    model: row.model,
    dimensions: Number(row.dimensions || embedding.length),
    embedding,
    createdAt: toIso(row.createdAt || row.created_at),
    lastUsedAt: toIso(row.lastUsedAt || row.last_used_at || row.createdAt || row.created_at)
  };
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function parseVector(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .filter(Boolean);
  const parsed = source.map((item) => Number(item || 0));
  return parsed.map((item) => Number.isFinite(item) ? item : 0);
}

function normalizeScore(score) {
  return Number((numberValue(score) / (numberValue(score) + 4)).toFixed(3));
}

function noveltyAgainstPrevious(terms, previousResults) {
  if (!previousResults.length) {
    return 1;
  }

  const maxOverlap = Math.max(
    ...previousResults.map((result) => jaccard(terms, result.chunk.terms || []))
  );

  return Number(Math.max(0, 1 - maxOverlap).toFixed(3));
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value) {
  if (!value) {
    return nowIso();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
