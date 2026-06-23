import { readFile } from 'node:fs/promises';

const sql = await readFile('docs/database/postgres-pgvector.sql', 'utf8');
const exporter = await readFile('scripts/postgres-export.js', 'utf8');
const statements = await readFile('src/services/postgres-statements.js', 'utf8');
const runtimeStore = await readFile('src/services/postgres-store.js', 'utf8');
const failures = [];

for (const phrase of [
  'CREATE EXTENSION IF NOT EXISTS vector',
  'CREATE TABLE IF NOT EXISTS raglens_projects',
  'CREATE TABLE IF NOT EXISTS raglens_documents',
  'CREATE TABLE IF NOT EXISTS raglens_chunks',
  'CREATE TABLE IF NOT EXISTS raglens_query_runs',
  'CREATE TABLE IF NOT EXISTS raglens_retrieved_chunks',
  'CREATE TABLE IF NOT EXISTS raglens_feedback',
  'CREATE TABLE IF NOT EXISTS raglens_eval_questions',
  'embedding vector(64) NOT NULL',
  'embedding_model text NOT NULL DEFAULT',
  'evidence_snapshot jsonb NOT NULL',
  'ON DELETE CASCADE',
  'USING hnsw (embedding vector_cosine_ops)',
  'raglens_eval_questions_project_question_unique_idx'
]) {
  requireSql(phrase, `schema includes ${phrase}`);
}

for (const table of [
  'raglens_documents',
  'raglens_chunks',
  'raglens_query_runs',
  'raglens_feedback',
  'raglens_eval_questions'
]) {
  requireTableColumn(table, 'project_id text NOT NULL', `${table} is project scoped`);
  requireSql(`REFERENCES raglens_projects(id) ON DELETE CASCADE`, `${table} cascades from projects`);
}

for (const table of ['raglens_documents', 'raglens_chunks']) {
  requireTableColumn(table, 'text text NOT NULL', `${table} stores source/evidence text`);
}

rejectSql('embedding vector(1536)', 'schema must not drift from local 64-dimensional hash embeddings');
rejectSql('CREATE TABLE IF NOT EXISTS users', 'hosted auth users are intentionally out of this local schema contract');

for (const phrase of [
  'exportStateToPostgresSql',
  'raglens_projects',
  'raglens_documents',
  'raglens_chunks',
  'raglens_query_runs',
  'raglens_retrieved_chunks',
  'raglens_feedback',
  'raglens_eval_questions',
  '::vector',
  'ON CONFLICT DO NOTHING'
]) {
  requireExporter(phrase, `exporter includes ${phrase}`);
}

for (const phrase of [
  'postgresStatements',
  'loadProjectState',
  'insertDocument',
  'insertChunk',
  'searchChunksByVector',
  'insertQueryRun',
  'insertRetrievedChunk',
  'upsertEvalQuestion',
  'insertFeedback',
  'assertSchema',
  'deleteStaleDocuments',
  '$14::vector',
  'embedding <=> q.embedding',
  'WHERE project_id = $1'
]) {
  requireStatements(phrase, `statement module includes ${phrase}`);
}

for (const phrase of [
  'PostgresRaglensStore',
  'createPgPool',
  'loadStateFromPostgres',
  'syncStateToPostgres',
  'retrieveContextFromPostgres',
  'assertPostgresSchema',
  'optional "pg" package'
]) {
  requireRuntimeStore(phrase, `runtime Postgres store includes ${phrase}`);
}

if (failures.length) {
  console.error('Postgres contract check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Postgres contract check passed.');

function requireSql(needle, label) {
  if (!sql.includes(needle)) {
    failures.push(label);
  }
}

function rejectSql(needle, label) {
  if (sql.includes(needle)) {
    failures.push(label);
  }
}

function requireExporter(needle, label) {
  if (!exporter.includes(needle)) {
    failures.push(label);
  }
}

function requireStatements(needle, label) {
  if (!statements.includes(needle)) {
    failures.push(label);
  }
}

function requireRuntimeStore(needle, label) {
  if (!runtimeStore.includes(needle)) {
    failures.push(label);
  }
}

function requireTableColumn(table, columnNeedle, label) {
  const block = tableBlock(table);
  if (!block.includes(columnNeedle)) {
    failures.push(label);
  }
}

function tableBlock(table) {
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`);
  return sql.match(pattern)?.[0] || '';
}
