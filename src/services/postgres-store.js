import { nowIso } from '../lib/time.js';
import { createDemoState } from '../demo.js';
import { EMBEDDING_DIMENSIONS, embedText } from '../rag/embedding.js';
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

    if (!loaded) {
      await this.save();
    }

    return this.snapshot();
  }

  async save() {
    this.pool ||= await this.poolFactory(this.config.postgres);
    this.state.updatedAt = nowIso();
    await syncStateToPostgres(this.pool, this.state);
  }

  async close() {
    await this.pool?.end?.();
  }

  async retrieveContext({ projectId, question, topK, retrievalMode, rerank }) {
    this.pool ||= await this.poolFactory(this.config.postgres);
    return retrieveContextFromPostgres(this.pool, {
      projectId,
      question,
      topK,
      retrievalMode,
      rerank
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
  const missing = ['projects', 'documents', 'chunks', 'runs', 'eval_questions'].filter((key) => !row[key]);

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

      await runStatement(client, postgresStatements.deleteStaleDocuments(project.id, projectDocuments.map((document) => document.id)));
      await runStatement(client, postgresStatements.deleteStaleQueryRuns(project.id, projectRuns.map((run) => run.id)));
      await runStatement(client, postgresStatements.deleteStaleEvalQuestions(project.id, projectEvalQuestions.map((item) => item.id)));
      await runStatement(client, postgresStatements.deleteStaleFeedback(project.id, feedback.map(({ item }) => item.id)));

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
  const queryTerms = uniqueTerms(question);

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

  const statement = postgresStatements.searchChunksByVector(options.projectId, queryTerms, embedText(question), {
    topK: options.topK,
    retrievalMode: options.retrievalMode,
    rerank: options.rerank
  });
  const rows = (await query(queryable, statement)).rows || [];
  const results = rows.map(mapSearchResult);
  const indexedChunks = Number(rows[0]?.indexedChunks ?? rows[0]?.indexed_chunks ?? results.length);
  const avgChunkTokens = results.length
    ? Number((results.reduce((sum, item) => sum + Number(item.chunk.tokenCount || 0), 0) / results.length).toFixed(1))
    : 0;

  return {
    queryTerms,
    results: results.map((result, index, chosen) => ({
      ...result,
      rank: index + 1,
      novelty: noveltyAgainstPrevious(result.chunk.terms, chosen.slice(0, index)),
      score: normalizeScore(result.rerankScore),
      similarityScore: Number(Math.max(0, result.vectorScore).toFixed(3))
    })),
    stats: {
      indexedChunks,
      avgChunkTokens,
      mode: options.retrievalMode || 'hybrid',
      rerank: options.rerank !== false,
      source: 'postgres-pgvector'
    }
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
    index: Number(row.index ?? row.chunkIndex ?? row.chunk_index ?? 0),
    label: row.label || '',
    heading: row.heading || row.section || 'Untitled section',
    section: row.section || row.heading || 'Untitled section',
    page: row.page === null || row.page === undefined ? null : Number(row.page),
    text: row.text || '',
    tokenCount: Number(row.tokenCount ?? row.token_count ?? 0),
    terms: arrayValue(row.terms),
    termCounts: row.termCounts || row.term_counts || {},
    embedding: parseVector(row.embedding),
    embeddingModel: row.embeddingModel || row.embedding_model || 'local-hash-embedding-v1',
    embeddedAt: toIso(row.embeddedAt || row.embedded_at),
    createdAt: toIso(row.createdAt || row.created_at || row.embeddedAt || row.embedded_at)
  };
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
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => {
    const number = parsed[index] || 0;
    return Number.isFinite(number) ? number : 0;
  });
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
