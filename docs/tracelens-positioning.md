# TraceLens Positioning

RAGLens and TraceLens are related, but they should not collapse into one tool.

TraceLens is the main project in the stack. It is the production-facing layer for traces, eval diffs, policy gates, review workflows, SLOs, model inventory, vLLM serving pressure, redacted review bundles, and incident-ready reports.

RAGLens is the local RAG workbench. It is best for creating a real run from documents: upload content, chunk it, retrieve evidence, generate an answer, inspect citations, compare local runs, and export the result.

## Boundary

| Need | Use | Reason |
| --- | --- | --- |
| Try a RAG workflow from documents to answer | RAGLens | It owns ingestion, chunking, retrieval, local generation, citations, and the browser inspector. |
| Tune chunk size, top-k, retrieval mode, reranking, and prompt settings | RAGLens | Those controls are part of the run creation loop. |
| Produce a concrete local demo or regression fixture | RAGLens | It ships with a seeded corpus, eval checks, and portable run bundles. |
| Compare releases across traces, eval reports, and model surfaces | TraceLens | It owns replay reports, eval diffs, deployment drift, fleet reports, and SLOs. |
| Route unsupported claims, stale tools, missing telemetry, or serving pressure | TraceLens | It turns failures into owner-ready review workflows and root-cause reports. |
| Prepare redacted PR, vendor, or incident artifacts | TraceLens | It owns redaction profiles, review bundles, signatures, and verification reports. |
| Monitor private open-weight infrastructure | TraceLens | It connects evidence quality to vLLM metrics, model inventory, fleet health, and Prometheus-compatible output. |

## Handoff

The preferred handoff is the staged RAG trace:

```bash
curl http://127.0.0.1:4177/api/query-runs/<run-id>/trace > raglens-trace-v2.json
```

Then import it in TraceLens:

```bash
node src/cli.js import-rag-trace raglens-trace-v2.json --out exports/raglens-trace.json
```

The contract preserves query variants, every retrieval stage, evidence provenance and page ranges, embedding and reranker identity, metadata filters, cache state, prompt context ids, abstention or fallback decisions, claims and citations, evaluation metrics, usage, privacy posture, and model identity. Raw content is omitted unless `includeContent=true` is explicitly requested on a trusted local transfer.

OTLP remains available from `/api/query-runs/<run-id>/otel` for generic collectors and framework integrations.

For an end-to-end demonstration, run `npm run stack:demo`. It creates a real baseline and stale-source candidate, imports both, applies the TraceLens release policy, and verifies a redacted review bundle.

RAGLens also exposes a richer local bundle:

```bash
curl http://127.0.0.1:4177/api/query-runs/<run-id>/bundle > raglens-run-bundle.json
```

The bundle is useful for reviewer handoff because it includes the hydrated run, retrieved evidence, source metadata, metrics, warnings, and review summary while omitting full prompt text, embedding vectors, and term-count internals.

## Stack Shape

```text
RAGLens generates and inspects a concrete RAG run
TraceLens monitors, gates, compares, routes, and explains failures
```

That split keeps RAGLens focused on the developer's local feedback loop and keeps TraceLens focused on production monitoring and governance.
