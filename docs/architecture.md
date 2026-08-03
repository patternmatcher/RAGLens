# Architecture

RAGLens is a small local-first app. It uses no runtime dependencies, which keeps the clone-and-run path short and makes the core RAG inspection logic easy to audit.

## Runtime

- Node.js HTTP server in `src/http/server.js`.
- Static browser app in `public/`.
- JSON persistence in `data/raglens.json`.
- Project-scoped local workspaces; `/api/state?projectId=...` returns documents, runs, chunks, and eval checks for one explicit project.
- In-process serial ingestion worker for optional queued document indexing; synchronous uploads remain available for the quick demo path.
- Local demo corpus created by `src/demo.js`.
- Deterministic local embeddings are the default. An OpenAI-compatible provider can supply production vectors in batches with explicit egress consent.
- Project-scoped content-addressed embedding cache entries contain vector data and SHA-256 keys, not original document or query text.
- Optional HTTP cross-encoder and ColBERT-style rerankers operate behind a bounded, index-based response contract.
- Optional OpenAI-compatible chat generation is configured by environment variables and never stores API keys in workspace settings or run history.
- Optional OTLP/HTTP trace export sends run pipeline spans to an operator-configured collector after each query.
- Optional PDF text extraction can call a trusted `pdftotext`-compatible command with `{input}` args and timeout, preserving form-feed page boundaries, then falls back to the internal dependency-free parser.

## Pipeline

1. A document is accepted synchronously through `POST /api/documents` or queued through the local ingestion worker at `POST /api/ingestion-jobs`. Existing documents in the requested project can be re-chunked with current settings through `POST /api/documents/reindex`.
2. The document is normalized and chunked by `src/rag/chunker.js`.
   PDF uploads are first extracted by `src/rag/pdf.js` using the configured external command when available, otherwise the internal Flate/text-operator parser.
3. Each chunk stores lexical features, allow-listed metadata, a content-derived stable id, source offsets, verified page ranges, and embedding profile identity.
4. `src/rag/query.js` rewrites and expands the query, detects ambiguity, and decomposes compound questions. An optional OpenAI-compatible planner uses a structured response contract and falls back locally.
5. `src/rag/embedding-provider.js` embeds each search query and reads or writes the project-scoped cache.
6. `src/rag/retriever.js` applies metadata filters, ranks sparse and dense candidates, fuses query variants, and selects the candidate pool.
7. `src/rag/reranker.js` optionally reranks candidates through a local heuristic, cross-encoder endpoint, or ColBERT-style late-interaction endpoint.
8. `src/rag/parent-context.js` can add neighboring section chunks under a token budget without changing child-chunk ranking metrics.
9. `src/rag/web-fallback.js` may add allow-listed search snippets after low-confidence retrieval. Otherwise the pipeline abstains.
10. `src/rag/provider.js` chooses deterministic local generation or an OpenAI-compatible chat provider.
11. `src/rag/evaluator.js` splits the answer into claims, grades support, and calculates retrieval, grounding, citation, and ranking metrics.
12. `src/rag/pipeline.js` records stages, selected evidence, warnings, cache behavior, usage, prompt metadata, and citations.
13. `src/observability/rag-trace-v2.js` exports the checked TraceLens contract. `src/observability/otel.js` exports generic OTLP/HTTP traces.

## Data Model

- `projects`: local workspace boundaries selected per client request.
- `documents`: source-level metadata and raw text scoped by project.
- `chunks`: retrievable text units with terms and source labels scoped by project.
- `runs`: immutable query inspections with config, retrieval results, answer, metrics, warnings, and trace scoped by project.
- `feedback`: stored on runs as thumbs up/down plus optional notes.
- `evalQuestions`: saved regression questions scoped by project.
- `settings`: per-project default retrieval and answer settings. A top-level `settings` field remains in the local JSON state for compatibility and mirrors the stable default project's settings.

## Hosted Persistence Contract

The local app persists to `data/raglens.json` for zero-dependency demos. Writes to the same workspace are serialized and committed through same-directory atomic replacement. Set `RAGLENS_STORAGE_DRIVER=postgres` and `RAGLENS_DATABASE_URL` to use the optional hosted Postgres runtime adapter in `src/services/postgres-store.js`; deployment images that choose this mode must install the optional `pg` package. Remote Postgres requires certificate-verified TLS unless the operator sets the explicit insecure local-network override. The hosted persistence schema lives at `docs/database/postgres-pgvector.sql` and is validated by `npm run postgres:contract`. It defines project-scoped tables for projects, documents, chunks, embedding cache entries, query runs, retrieved chunks, feedback, and eval questions. Chunk vectors use provider-defined dimensions, record provider and model identity, and use a partial HNSW index for the default 64-dimensional local profile. Parameterized retrieval filters vectors by model and dimension before comparison. JSON mode uses the same retrieval semantics in process.

`npm run postgres:export -- --input ./data/raglens.json --out ./raglens-seed.sql` converts a local JSON workspace into idempotent SQL inserts for that schema. `npm run postgres:export -- --demo` emits a built-in demo seed without reading local data.

## Compare Runs

`src/services/store.js` hydrates both selected runs inside the requested project and returns a comparison payload with metric deltas, config diffs, answer summaries, warning changes, and retrieval movement. Retrieval movement includes shared chunks, baseline-only chunks, candidate-only chunks, exact chunk overlap, stable source overlap, source score deltas, and whether the top chunk or source changed.

## Run Bundles

`GET /api/query-runs/:id/bundle` exports a project-scoped JSON bundle for one inspected run. Project-scoped read and mutation endpoints accept a `projectId` query/body field so concurrent clients remain independent. Project settings are scoped the same way, so chunking, model, prompt, and retrieval defaults follow the targeted project. The bundle includes the hydrated run, retrieved chunk text, source document metadata, evaluation metrics, warning types, and a review summary. Full prompt text is omitted from portable bundles even when prompt logging was enabled for the original run.

## TraceLens Boundary

RAGLens owns the local run creation loop: documents, chunks, retrieval, prompt controls, answer generation, citations, eval checks, and the inspector UI. TraceLens is the main monitoring and governance layer for the wider stack. It owns trace artifact validation, release gates, eval diffs, review workflows, SLOs, redacted bundles, vLLM overlays, and fleet-level reporting.

For the richest handoff, export `tracelens.rag-trace/v2` from `GET /api/query-runs/:id/trace`. TraceLens preserves staged retrieval, exact evidence provenance, cache data, abstention, fallback, and evaluation metrics. OTLP remains available for generic collector and framework integration. Use the RAGLens run bundle when a reviewer needs the local evidence package.

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
- Embedding profile mismatch: indexed and query vectors use different models or dimensions.
- Unexpected abstention: expected evidence exists but the answer path withholds a response.
- Web fallback failure: an approved low-confidence fallback cannot return usable evidence.
