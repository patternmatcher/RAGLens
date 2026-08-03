# Implementation Matrix

This matrix tracks what is implemented, where the code lives, and what still depends on external services or deployment choices.

Legend:

- Complete: implemented and covered by tests, runtime checks, docs, or release checks.
- Partial: implemented in the repo, but live infrastructure or an optional external tool is still required.
- External: depends on tooling outside this workspace.

## Core Flow

| Plan item | Status | Evidence |
| --- | --- | --- |
| Create and select project/workspace | Complete | `src/services/store.js`, `POST /api/projects`, explicit `projectId` request scoping, and the compatibility snapshot endpoint at `PATCH /api/projects/active` |
| Upload TXT, Markdown, CSV, JSON, log, PDF | Complete | `src/rag/chunker.js`, `src/rag/pdf.js`, `test/pdf.test.js`, `test/server.test.js`. CSV is indexed as text, not table-aware relational parsing. |
| Chunk documents and embed chunks | Complete | `src/rag/chunker.js`, `src/rag/embedding-provider.js`, `test/chunker.test.js`, `test/advanced-rag.test.js`. Local and OpenAI-compatible profiles, model/dimension identity, batching, and content-addressed caching are implemented. |
| Ask a question and retrieve top chunks | Complete | `src/rag/query.js`, `src/rag/retriever.js`, `src/rag/reranker.js`, `src/rag/parent-context.js`, `src/rag/pipeline.js`, and retrieval tests cover rewriting, sparse/dense fusion, filters, candidate depth, reranking, and parent context. |
| Generate answer with citations | Complete | `src/rag/generator.js`, `src/rag/provider.js`, `src/rag/evaluator.js` |
| Inspector trace from query to evaluation | Complete | `public/app.js`, `src/rag/pipeline.js`, `test/frontend.test.js` |
| Compare runs across config changes | Complete | `src/services/store.js`, `public/app.js`, `test/server.test.js`. Chunk-size experiments are supported by changing settings, reindexing with `POST /api/documents/reindex`, then comparing runs with exact chunk overlap and stable source overlap. |

## Architecture Decisions And Deviations

| Original plan area | Status | Evidence / note |
| --- | --- | --- |
| Frontend: Next.js, TypeScript, Tailwind, shadcn/ui, Recharts | Implemented differently | RAGLens is a dependency-free static app in `public/` with custom CSS and vanilla JS. The same screens and workflows are implemented without the proposed frontend stack. |
| Backend: Next.js API routes or FastAPI | Implemented differently | Dependency-free Node HTTP server in `src/http/server.js`. |
| Database: Postgres with pgvector | Partial | Optional runtime adapter, schema, exporter, database-side pgvector candidate retrieval, and contract exist. Live DB verification requires Postgres with pgvector and the optional `pg` package. |
| ORM: Prisma or Drizzle | Not used | Parameterized SQL statement layer in `src/services/postgres-statements.js`; no ORM dependency. |
| Queue/background worker for ingestion | Complete | Dependency-free in-process serial ingestion worker in `src/services/ingestion-worker.js`, `POST /api/ingestion-jobs`, status UI in `public/app.js`, and API/server tests. This is not a distributed Redis queue. |
| LLM provider interface | Complete | Local provider and OpenAI-compatible provider path in `src/rag/provider.js`. |
| Auth/project separation | Partial | Admin token, project-scoped resources/settings, and explicit `projectId` request targeting exist. Public multi-user auth and row-level tenancy remain roadmap items. |

## MVP Features

| Plan item | Status | Evidence |
| --- | --- | --- |
| Document ingestion and chunk previews | Complete | Documents view in `public/app.js`; `DocumentCreateResult` in `docs/api/openapi.json` |
| Chunk metadata: document, section, page, tokens, timestamp | Complete | `chunkSnapshot()` in `src/services/store.js`; `EvidenceChunk` schema. External PDF extraction preserves exact page ranges and source offsets; fallback parsing reports pages as unknown rather than estimating them. |
| Query workbench controls | Complete | Workbench UI exposes top-k, candidate depth, retrieval mode, reranking, parent context budget, and metadata scope; `validateQueryInput()` applies bounded allow-listed values. |
| Retrieved chunk panel with scores and matched terms | Complete | Inspector UI and `retrieved` run payload |
| Answer panel with citations mapped to chunks | Complete | `hydrateRun()`, `source-label.js`, inspector tests |
| Failure labels and warnings | Complete | `src/rag/evaluator.js`, `src/rag/pipeline.js`, `docs/architecture.md` |
| Run history | Complete | `listRuns()`, dashboard/inspector UI |
| Source usage heatmap | Complete | Per-source `sourceSupport` scoring in `src/rag/evaluator.js`, `renderSourceUsageMatrix()` in `public/app.js`, and heatmap tests |

## Metrics

| Metric | Status | Evidence |
| --- | --- | --- |
| Retrieval precision@k | Complete | `src/rag/evaluator.js`, `docs/evaluation.md`, `scripts/rag-eval.js` |
| Recall@k | Complete | `src/rag/evaluator.js`, `test/server.test.js` |
| MRR | Complete | `src/rag/evaluator.js`, `docs/evaluation.md` |
| Hit rate@k and NDCG@k | Complete | `src/rag/evaluator.js`, inspector UI, golden benchmark, TraceLens export |
| Context relevance | Complete | `src/rag/evaluator.js` |
| Faithfulness | Complete | `src/rag/evaluator.js`, heatmap UI |
| Citation coverage | Complete | `src/rag/evaluator.js` |
| Redundancy | Complete | `src/rag/evaluator.js` |
| Latency and token/cost accounting | Complete | `src/rag/pipeline.js`, `src/rag/cost.js`, `test/cost.test.js` |
| Embedding cache behavior | Complete | Per-run hits, misses, hit rate, embedding latency, JSON/Postgres persistence, benchmark report, and TraceLens export |
| Held-out heuristic calibration | Complete | `scripts/calibrate-evaluations.js`, `docs/evaluation-calibration.md`. Calibration uses source-removed negative controls and reports a deterministic 80/20 split separately from eval-set ground truth. |

## Screens

| Screen | Status | Evidence |
| --- | --- | --- |
| Dashboard | Complete | `public/app.js`, browser-rendered screenshot |
| Documents | Complete | `public/app.js`, document API tests |
| Query Workbench | Complete | `public/app.js`, query-run tests |
| Run Inspector | Complete | `public/app.js`, bundle/heatmap tests |
| Compare Runs | Complete | `public/app.js`, `compareRuns()` |
| Eval Set | Complete | `public/app.js`, eval question API tests |
| Settings | Complete | `public/app.js`, provider/storage/parser status tests |

## Release Readiness

| Plan item | Status | Evidence |
| --- | --- | --- |
| Docker Compose | Complete | `Dockerfile`, `docker-compose.yml`, `scripts/docker-check.js`, and `scripts/docker-runtime.js`. The runtime check builds the image, starts the container on loopback, verifies token-protected state access, runs a query, exports a bundle, and removes the test image. |
| Seed demo dataset | Complete | `src/demo.js`, `scripts/seed-demo.js`, `scripts/rag-eval.js` |
| External corpus evaluation | Complete | `scripts/corpus-fetch.js`, `scripts/corpus-eval.js`, `scripts/corpus-app-demo.js`, `docs/corpus-evaluation.md`, `docs/app-corpus-demo.md`. Downloaded corpus files stay in ignored `corpora/`; the current reports cover SQuAD, StratRAG, and SciFact slices plus an HTTP API app demo. |
| Golden evaluation and naive baseline | Complete | `evals/golden-rag-v1.json` contains 60 checked cases; `scripts/golden-eval.js` produces `raglens.rag-benchmark/v1`, enforces release thresholds, and writes `docs/rag-benchmark.md`. |
| README screenshot and architecture diagram | Complete | `README.md`, `docs/assets/dashboard.png`, Mermaid diagram |
| CI workflows | Complete | `.github/workflows/ci.yml`, `.github/workflows/rag-evals.yml`, `scripts/lint.js`. `npm run build` checks syntax and `npm run lint` checks security/workflow hygiene; there is no TypeScript typecheck because the app is plain JavaScript. |
| Unit, integration, browser, contract tests | Complete | `test/`, browser/service scripts, and contract scripts |
| `.env.example`, contribution, security, issue templates | Complete | `.env.example`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/` |
| RAG failure mode docs | Complete | `docs/architecture.md`, `docs/evaluation.md`, `docs/security-model.md` |
| Release readiness doctor | Complete | `scripts/release-doctor.js`, `test/release-doctor.test.js` |
| RAGLens to TraceLens release path | Complete | `scripts/tracelens-stack-demo.js` creates baseline and stale-source traces in RAGLens, imports them into TraceLens, applies the release gate, and verifies a redacted review bundle. |
| Live open-weight stack proof | Partial | `scripts/open-weight-stack-eval.js` and `scripts/vllm-wsl-bridge.py` provide the local vLLM, external corpus, authenticated TraceLens collector, and gate path. A compatible GPU runtime and local model are required, so release evidence is generated under ignored `corpora/results/` rather than committed as a universal benchmark. |

## Security

| Plan item | Status | Evidence |
| --- | --- | --- |
| Redact API keys/secrets | Complete | `src/security/redact.js`, `test/server.test.js` |
| Disable prompt logging | Complete | Prompt logging is off by default, settings can opt in, bundles omit full prompt text, and prompt-null tests cover the behavior. |
| Prompt-injection-like retrieved text warning | Complete | pre-generation scan in `src/rag/pipeline.js` |
| Sensitive context warning | Complete | `inspectChunksForSensitiveData()` |
| Live provider egress guard | Complete | `provider-egress-blocked` warnings in `src/rag/pipeline.js`, OpenAPI `allowUnsafeProviderEgress`, and provider URL transport checks in `src/config.js` |
| Embedding, planner, reranker, and web egress controls | Complete | Remote embeddings, query planning, and web search require deployment consent; reranking also honors per-run risky-content egress blocking; URLs reject unsafe transport outside approved local use. |
| Vector/embedding risk documentation | Complete | `docs/security-model.md` |
| Public API avoids raw secrets and embeddings | Complete | `docs/api/openapi.json`, `scripts/api-contract.js`, `test/server.test.js` |
| PDF parsing hardening | Complete | byte caps, per-stream and aggregate stream caps, minimal external env, `test/pdf.test.js` |
| Browser upload guardrails | Complete | Client-side text/PDF size checks mirror server caps before file reads; `public/app.js`, `test/frontend.test.js` |

## Optional Features

| Plan item | Status | Evidence |
| --- | --- | --- |
| Reranker support | Complete | Deterministic local reranker plus indexed-response HTTP cross-encoder and ColBERT-style late-interaction adapters in `src/rag/reranker.js` |
| Hybrid vector + keyword search | Complete | `src/rag/retriever.js` |
| Query rewriting inspection | Complete | Deterministic expansion/decomposition plus optional OpenAI-compatible structured planner in `src/rag/query.js`; query variants and fallback state appear in the inspector and shared trace. |
| Metadata filtering | Complete | Document metadata UI/API, pre-scoring in-memory filters, parameterized Postgres filters, and workbench scope controls |
| Parent-document retrieval | Complete | Section-neighbor expansion under a bounded token budget with separate child ranking metrics |
| Low-confidence fallback | Complete | Evidence-aware abstention and optional domain-restricted SearXNG snippet fallback in `src/rag/web-fallback.js` |
| Shared TraceLens contract | Complete | `tracelens.rag-trace/v2`, `raglens.rag-benchmark/v1`, sibling importer checks, staged pipeline display, diagnostics, comparisons, and policy thresholds |
| OpenTelemetry trace export | Complete | `src/observability/otel.js`, `/api/query-runs/:id/otel` |
| Instance-local share link for a run | Complete | `GET /api/share/:id`, share-link UI. Public internet sharing depends on the chosen host/auth setup. |
| Why did this fail summary | Complete | evaluation warnings and failure summary surfaced in inspector |
| GitHub Action RAG evals | Complete | `.github/workflows/rag-evals.yml` |
| Postgres + pgvector | Partial | Schema/export/runtime adapter and database-side pgvector candidate retrieval exist; live DB verification requires Postgres with pgvector and the optional `pg` package. |

## Verification Commands

Run these before publishing:

```bash
npm run doctor
npm run preflight
npm run lint
npm run eval:calibrate
npm run stack:demo
npm run postgres:export -- --demo
npm run release:audit -- --json
```

Current local limitations are reported by `npm run doctor`: Docker or Git may be unavailable on a given machine, and generated `data/` folders are ignored but should be checked before committing.

## Limitations

- PDF text extraction remains best effort. Configured `pdftotext` output preserves exact form-feed page boundaries; the internal parser deliberately reports page numbers as unavailable because it cannot guarantee PDF page-object mapping.
- CSV support indexes CSV content as text, not as a typed table model.
- Faithfulness and context relevance are deterministic lexical heuristics, not an LLM judge.
- pgvector support proves hosted persistence, vector storage/indexing contracts, and the parameterized database-side candidate retrieval path; live DB execution still needs to be verified against the target Postgres instance.
- Security features are redaction, warnings, safer defaults, and documentation; RAGLens is not a complete DLP scanner or multi-user auth system.
- Live OpenAI-compatible providers, live OTLP collectors, Git status, and live Postgres should be exercised in the target deployment environment. Docker is covered by `npm run docker:runtime` when the daemon is available.
