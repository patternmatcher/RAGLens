-- RAGLens hosted persistence schema for PostgreSQL + pgvector.
-- This migration mirrors the local JSON store while preserving project-level isolation.
-- Runtime support for this schema is a hosted deployment adapter boundary; the local app remains JSON-backed.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS raglens_projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raglens_documents (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES raglens_projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  source_type text NOT NULL,
  text text NOT NULL,
  checksum text NOT NULL,
  word_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'indexed',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raglens_documents_source_type_check
    CHECK (source_type IN ('text', 'markdown', 'csv', 'json', 'log', 'pdf'))
);

CREATE TABLE IF NOT EXISTS raglens_chunks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES raglens_projects(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES raglens_documents(id) ON DELETE CASCADE,
  document_title text NOT NULL,
  chunk_index integer NOT NULL,
  label text NOT NULL,
  heading text NOT NULL,
  section text NOT NULL,
  page integer,
  text text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  term_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(64) NOT NULL,
  embedding_model text NOT NULL DEFAULT 'local-hash-embedding-v1',
  embedded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS raglens_query_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES raglens_projects(id) ON DELETE CASCADE,
  question text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  query jsonb NOT NULL DEFAULT '{}'::jsonb,
  query_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieved jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluation jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  trace jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  redactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_snapshot jsonb NOT NULL DEFAULT '{"documents":[],"chunks":[]}'::jsonb,
  observability jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raglens_retrieved_chunks (
  run_id text NOT NULL REFERENCES raglens_query_runs(id) ON DELETE CASCADE,
  chunk_id text NOT NULL,
  rank integer NOT NULL,
  score double precision NOT NULL DEFAULT 0,
  raw_score double precision NOT NULL DEFAULT 0,
  lexical_score double precision NOT NULL DEFAULT 0,
  similarity_score double precision NOT NULL DEFAULT 0,
  rerank_score double precision NOT NULL DEFAULT 0,
  coverage double precision NOT NULL DEFAULT 0,
  novelty double precision NOT NULL DEFAULT 0,
  matched_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (run_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS raglens_feedback (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES raglens_query_runs(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES raglens_projects(id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  note text NOT NULL DEFAULT '',
  expected_answer text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raglens_eval_questions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES raglens_projects(id) ON DELETE CASCADE,
  question text NOT NULL,
  expected_source text NOT NULL,
  expected_answer text NOT NULL DEFAULT '',
  redactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raglens_documents_project_idx
  ON raglens_documents(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS raglens_chunks_project_document_idx
  ON raglens_chunks(project_id, document_id, chunk_index);

CREATE INDEX IF NOT EXISTS raglens_chunks_embedding_hnsw_idx
  ON raglens_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS raglens_query_runs_project_created_idx
  ON raglens_query_runs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS raglens_retrieved_chunks_run_rank_idx
  ON raglens_retrieved_chunks(run_id, rank);

CREATE INDEX IF NOT EXISTS raglens_feedback_project_run_idx
  ON raglens_feedback(project_id, run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS raglens_eval_questions_project_idx
  ON raglens_eval_questions(project_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS raglens_eval_questions_project_question_unique_idx
  ON raglens_eval_questions(project_id, lower(question));
