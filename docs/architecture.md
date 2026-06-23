# Architecture

RAGLens is a small local-first app. It uses no runtime dependencies, which keeps the clone-and-run path short and makes the core RAG inspection logic easy to audit.

## Runtime

- Node.js HTTP server in `src/http/server.js`.
- Static browser app in `public/`.
- JSON persistence in `data/raglens.json`.
- Project-scoped local workspaces; `/api/state` returns documents, runs, chunks, and eval checks for the active project.
- In-process serial ingestion worker for optional queued document indexing; synchronous uploads remain available for the quick demo path.
- Local demo corpus created by `src/demo.js`.
- Local hash embeddings are stored on chunks for deterministic vector and hybrid retrieval.
- Optional OpenAI-compatible chat generation is configured by environment variables and never stores API keys in workspace settings or run history.
- Optional OTLP/HTTP trace export sends run pipeline spans to an operator-configured collector after each query.
- Optional PDF text extraction can call a trusted `pdftotext`-compatible command with `{input}` args and timeout, then falls back to the internal dependency-free parser.

## Pipeline

1. A document is accepted synchronously through `POST /api/documents` or queued through the local ingestion worker at `POST /api/ingestion-jobs`. Existing active-project documents can be re-chunked with current settings through `POST /api/documents/reindex`.
2. The document is normalized and chunked by `src/rag/chunker.js`.
   PDF uploads are first extracted by `src/rag/pdf.js` using the configured external command when available, otherwise the internal Flate/text-operator parser.
3. Each chunk stores lightweight lexical features, metadata, and a local embedding.
4. `src/rag/retriever.js` scores chunks with keyword, vector, or hybrid retrieval plus optional reranking.
5. `src/rag/query.js` rewrites the query and builds the prompt trace.
6. `src/rag/provider.js` chooses deterministic local generation or an OpenAI-compatible chat provider.
7. `src/rag/generator.js` creates an extractive grounded answer from high-scoring sentences when local mode or provider fallback is used.
8. `src/rag/evaluator.js` splits the answer into claims and grades each claim against its cited chunk.
9. `src/rag/pipeline.js` records a trace, metrics, warnings, usage, prompt, and citations.
10. `src/observability/otel.js` can transform the run trace into OTLP JSON and export it to a configured collector.

## Data Model

- `projects`: local workspace boundaries with active-project selection.
- `documents`: source-level metadata and raw text scoped by project.
- `chunks`: retrievable text units with terms and source labels scoped by project.
- `runs`: immutable query inspections with config, retrieval results, answer, metrics, warnings, and trace scoped by project.
- `feedback`: stored on runs as thumbs up/down plus optional notes.
- `evalQuestions`: saved regression questions scoped by project.
- `settings`: per-project default retrieval and answer settings. A top-level `settings` field remains in the local JSON state for compatibility and mirrors the active project's settings.

## Hosted Persistence Contract

The local app persists to `data/raglens.json` for zero-dependency demos. Set `RAGLENS_STORAGE_DRIVER=postgres` and `RAGLENS_DATABASE_URL` to use the optional hosted Postgres runtime adapter in `src/services/postgres-store.js`; deployment images that choose this mode must install the optional `pg` package. The hosted persistence schema lives at `docs/database/postgres-pgvector.sql` and is validated by `npm run postgres:contract`. It defines project-scoped tables for projects, documents, chunks, query runs, retrieved chunks, feedback, and eval questions; enables `pgvector`; stores local hash embeddings as `vector(64)`; and adds an HNSW cosine index for vector retrieval. In Postgres mode, query runs use a parameterized pgvector candidate retrieval statement before generation. JSON mode keeps using the in-process retriever. `src/services/postgres-statements.js` contains the parameterized SQL boundary used by the runtime adapter and seed exporter.

`npm run postgres:export -- --input ./data/raglens.json --out ./raglens-seed.sql` converts a local JSON workspace into idempotent SQL inserts for that schema. `npm run postgres:export -- --demo` emits a built-in demo seed without reading local data.

## Compare Runs

`src/services/store.js` hydrates both selected runs inside the active project and returns a comparison payload with metric deltas, config diffs, answer summaries, warning changes, and retrieval movement. Retrieval movement includes shared chunks, baseline-only chunks, candidate-only chunks, exact chunk overlap, stable source overlap, source score deltas, and whether the top chunk or source changed.

## Run Bundles

`GET /api/query-runs/:id/bundle` exports a project-scoped JSON bundle for one inspected run. Project-scoped read and mutation endpoints accept an optional `projectId` query/body field so concurrent clients do not have to rely on the instance-wide active project pointer. Project settings are scoped the same way, so chunking, model, prompt, and retrieval defaults follow the targeted project. The bundle includes the hydrated run, retrieved chunk text, source document metadata, evaluation metrics, warning types, and a review summary. Full prompt text is omitted from portable bundles even when prompt logging was enabled for the original run.

## Generation Modes

The default mode favors reliability and inspectability over model cleverness. The local answer generator makes the retrieval and evaluation flow easy to test without API keys or model nondeterminism.

When `RAGLENS_OPENAI_API_KEY` is configured and the provider is set to `openai-compatible`, RAGLens calls a `/chat/completions` endpoint with the same retrieved context and stable source labels. Provider failures fall back to local grounded generation and are recorded as run warnings.

## Failure Modes Represented

- Retrieval miss: no matching chunks returned.
- Low confidence retrieval: top score is weak.
- Redundant context: retrieved chunks overlap heavily.
- Unsupported answer claim: generated text is not grounded in retrieved chunks.
- Conflicting sources: retrieved context mixes stale/deprecated and current/active source language.
- Prompt injection risk: retrieved text contains instruction-like attack language.
