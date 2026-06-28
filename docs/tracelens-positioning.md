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

The simplest handoff is telemetry:

```bash
curl http://127.0.0.1:4177/api/query-runs/<run-id>/otel > raglens-otel.json
```

Then import that OTLP-style payload in TraceLens:

```bash
node src/cli.js import-openinference raglens-otel.json --out exports/raglens-trace.json
```

RAGLens also exposes a richer local bundle:

```bash
curl http://127.0.0.1:4177/api/query-runs/<run-id>/bundle > raglens-run-bundle.json
```

The bundle is useful for reviewer handoff because it includes the hydrated run, retrieved evidence, source metadata, metrics, warnings, and review summary while omitting full prompt text, embedding vectors, and term-count internals.

## Stack Shape

```text
RAGLens generates and inspects a concrete RAG run
An external verifier optionally decomposes and verifies answer claims
TraceLens monitors, gates, compares, routes, and explains failures
```

That split keeps RAGLens focused on the developer's local feedback loop and keeps TraceLens focused on production monitoring and governance.
