import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDemoState } from '../src/demo.js';

export function exportStateToPostgresSql(state) {
  const normalized = normalizeState(state);
  const statements = [
    '-- RAGLens local JSON to PostgreSQL/pgvector seed export.',
    '-- Apply docs/database/postgres-pgvector.sql before running this file.',
    'BEGIN;',
    ...insertProjects(normalized),
    ...insertDocuments(normalized.documents),
    ...insertChunks(normalized.chunks),
    ...insertRuns(normalized.runs),
    ...insertRetrievedChunks(normalized.runs),
    ...insertFeedback(normalized.runs),
    ...insertEvalQuestions(normalized.evalQuestions),
    'COMMIT;'
  ];

  return `${statements.filter(Boolean).join('\n\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = args.demo ? createDemoState() : await readState(args.input);
  const sql = exportStateToPostgresSql(state);

  if (args.out) {
    await writeFile(args.out, sql, 'utf8');
    console.log(`Postgres seed SQL written to ${args.out}`);
    return;
  }

  process.stdout.write(sql);
}

async function readState(inputPath) {
  const filePath = inputPath || loadConfig().dataFile;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`State file not found at ${filePath}. Run npm run seed or pass --demo.`);
    }
    throw error;
  }
}

function parseArgs(args) {
  const parsed = {
    demo: false,
    input: '',
    out: ''
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--demo') {
      parsed.demo = true;
    } else if (arg === '--input') {
      parsed.input = path.resolve(args[index + 1] || '');
      index += 1;
    } else if (arg === '--out') {
      parsed.out = path.resolve(args[index + 1] || '');
      index += 1;
    }
  }

  return parsed;
}

function normalizeState(state) {
  const activeProjectId = state.activeProjectId || state.projects?.[0]?.id || '';
  const topLevelSettings = state.settings || {};
  return {
    projects: (state.projects || []).map((project) => ({
      ...project,
      settings: project.settings || (project.id === activeProjectId ? topLevelSettings : {})
    })),
    activeProjectId,
    settings: topLevelSettings,
    documents: state.documents || [],
    chunks: state.chunks || [],
    runs: state.runs || [],
    evalQuestions: state.evalQuestions || []
  };
}

function insertProjects(state) {
  return insertRows(
    'raglens_projects',
    ['id', 'name', 'description', 'owner_id', 'settings', 'created_at', 'updated_at'],
    state.projects.map((project) => [
      project.id,
      project.name,
      project.description || '',
      null,
      jsonValue(project.settings || (project.id === state.activeProjectId ? state.settings : {})),
      timestampValue(project.createdAt),
      timestampValue(project.updatedAt || project.createdAt)
    ])
  );
}

function insertDocuments(documents) {
  return insertRows(
    'raglens_documents',
    ['id', 'project_id', 'title', 'source_type', 'text', 'checksum', 'word_count', 'status', 'metadata', 'created_at', 'updated_at'],
    documents.map((document) => [
      document.id,
      document.projectId,
      document.title,
      document.sourceType,
      document.text,
      document.checksum,
      numberValue(document.wordCount),
      document.status || 'indexed',
      jsonValue(document.metadata || {}),
      timestampValue(document.createdAt),
      timestampValue(document.updatedAt || document.createdAt)
    ])
  );
}

function insertChunks(chunks) {
  return insertRows(
    'raglens_chunks',
    [
      'id',
      'project_id',
      'document_id',
      'document_title',
      'stable_chunk_id',
      'chunk_index',
      'label',
      'heading',
      'section',
      'page',
      'page_start',
      'page_end',
      'page_numbers_exact',
      'character_start',
      'character_end',
      'text',
      'token_count',
      'terms',
      'term_counts',
      'embedding',
      'embedding_provider',
      'embedding_model',
      'embedding_dimensions',
      'embedded_at',
      'created_at'
    ],
    chunks.map((chunk) => [
      chunk.id,
      chunk.projectId,
      chunk.documentId,
      chunk.documentTitle,
      chunk.stableChunkId || chunk.id,
      numberValue(chunk.index),
      chunk.label,
      chunk.heading || chunk.section || 'Untitled section',
      chunk.section || chunk.heading || 'Untitled section',
      nullableNumber(chunk.page),
      nullableNumber(chunk.pageStart ?? chunk.page),
      nullableNumber(chunk.pageEnd ?? chunk.page),
      chunk.pageNumbersExact === true,
      nullableNumber(chunk.characterStart),
      nullableNumber(chunk.characterEnd),
      chunk.text,
      numberValue(chunk.tokenCount),
      jsonValue(chunk.terms || []),
      jsonValue(chunk.termCounts || {}),
      vectorValue(chunk.embedding),
      chunk.embeddingProvider || 'local',
      chunk.embeddingModel || 'local-hash-embedding-v1',
      numberValue(chunk.embeddingDimensions || chunk.embedding?.length || 64),
      timestampValue(chunk.embeddedAt),
      timestampValue(chunk.createdAt || chunk.embeddedAt)
    ])
  );
}

function insertRuns(runs) {
  return insertRows(
    'raglens_query_runs',
    [
      'id',
      'project_id',
      'question',
      'config',
      'query',
      'query_terms',
      'retrieved',
      'answer',
      'evaluation',
      'prompt',
      'warnings',
      'trace',
      'usage',
      'redactions',
      'evidence_snapshot',
      'observability',
      'latency_ms',
      'created_at'
    ],
    runs.map((run) => [
      run.id,
      run.projectId,
      run.question,
      jsonValue(run.config || {}),
      jsonValue(run.query || {}),
      jsonValue(run.queryTerms || []),
      jsonValue(run.retrieved || []),
      jsonValue(run.answer || {}),
      jsonValue(run.evaluation || {}),
      run.prompt ? jsonValue(run.prompt) : null,
      jsonValue(run.warnings || []),
      jsonValue(run.trace || []),
      jsonValue(run.usage || {}),
      jsonValue(run.redactions || []),
      jsonValue(run.evidenceSnapshot || { documents: [], chunks: [] }),
      jsonValue(run.observability || {}),
      numberValue(run.latencyMs),
      timestampValue(run.createdAt)
    ])
  );
}

function insertRetrievedChunks(runs) {
  const rows = runs.flatMap((run) =>
    (run.retrieved || []).map((item) => [
      run.id,
      item.chunkId,
      numberValue(item.rank),
      numberValue(item.score),
      numberValue(item.rawScore),
      numberValue(item.lexicalScore),
      numberValue(item.similarityScore),
      numberValue(item.rerankScore),
      numberValue(item.coverage),
      numberValue(item.novelty),
      jsonValue(item.matchedTerms || []),
      jsonValue(item.missingTerms || [])
    ])
  );

  return insertRows(
    'raglens_retrieved_chunks',
    [
      'run_id',
      'chunk_id',
      'rank',
      'score',
      'raw_score',
      'lexical_score',
      'similarity_score',
      'rerank_score',
      'coverage',
      'novelty',
      'matched_terms',
      'missing_terms'
    ],
    rows
  );
}

function insertFeedback(runs) {
  const rows = runs.flatMap((run) =>
    (run.feedback || []).map((feedback) => [
      feedback.id,
      run.id,
      run.projectId,
      feedback.rating === 'down' ? 'down' : 'up',
      feedback.note || '',
      feedback.expectedAnswer || '',
      timestampValue(feedback.createdAt)
    ])
  );

  return insertRows(
    'raglens_feedback',
    ['id', 'run_id', 'project_id', 'rating', 'note', 'expected_answer', 'created_at'],
    rows
  );
}

function insertEvalQuestions(evalQuestions) {
  return insertRows(
    'raglens_eval_questions',
    ['id', 'project_id', 'question', 'expected_source', 'expected_answer', 'redactions', 'created_at', 'updated_at'],
    evalQuestions.map((item) => [
      item.id,
      item.projectId,
      item.question,
      item.expectedSource,
      item.expectedAnswer || '',
      jsonValue(item.redactions || []),
      timestampValue(item.createdAt),
      timestampValue(item.updatedAt || item.createdAt)
    ])
  );
}

function insertRows(table, columns, rows) {
  if (!rows.length) {
    return [];
  }

  const values = rows
    .map((row) => `(${row.map(sqlLiteral).join(', ')})`)
    .join(',\n  ');

  return [
    `INSERT INTO ${table} (${columns.join(', ')})\nVALUES\n  ${values}\nON CONFLICT DO NOTHING;`
  ];
}

function jsonValue(value) {
  return {
    type: 'jsonb',
    value
  };
}

function vectorValue(value) {
  const vector = Array.isArray(value) && value.length
    ? value.slice(0, 8_192)
    : Array.from({ length: 64 }, () => 0);

  return {
    type: 'vector',
    value: `[${vector.map((item) => Number(item || 0)).join(',')}]`
  };
}

function timestampValue(value) {
  return {
    type: 'timestamp',
    value: value || new Date(0).toISOString()
  };
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0';
  }
  if (value?.type === 'jsonb') {
    return `${quoteSql(JSON.stringify(value.value))}::jsonb`;
  }
  if (value?.type === 'vector') {
    return `${quoteSql(value.value)}::vector`;
  }
  if (value?.type === 'timestamp') {
    return `${quoteSql(value.value)}::timestamptz`;
  }

  return quoteSql(String(value));
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
