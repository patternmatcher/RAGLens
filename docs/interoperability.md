# TraceLens Interoperability

RAGLens creates and inspects RAG runs. TraceLens consumes those runs across services and releases for policy gates, comparisons, diagnostics, review workflows, and fleet reporting.

## Run Trace

`GET /api/query-runs/:id/trace` returns `tracelens.rag-trace/v2`. The artifact contains:

- query rewrite, expansions, decomposition, ambiguity, and expected evidence
- corpus and chunking identity
- sparse, dense, fusion, rerank, late-interaction, parent, context, and web stages when used
- every referenced evidence chunk with document, stable chunk id, exact page range, source URI, and extraction method
- generation provider, model, context ids, tokens, and status
- answer claims, support status, citations, and abstention state
- hit rate, precision, recall, MRR, NDCG, faithfulness, citation coverage, confidence, and focus
- embedding cache, stage latency, total latency, and estimated cost
- privacy posture and structured warnings

Content is omitted by default. Add `?includeContent=true` only for a trusted local transfer. TraceLens preserves the pipeline stages and evidence lineage when it imports the artifact.

## Benchmark Report

`npm run benchmark:rag` writes `raglens.rag-benchmark/v1` to `benchmarks/rag-naive-vs-enhanced.json`. TraceLens validates and renders the suite, profiles, metric deltas, cache behavior, resource measurements, and release gate.

## Checked Boundary

Run:

```bash
npm run interop:contract
npm run stack:demo
```

The contract command creates a real RAGLens run and validates it with the sibling TraceLens importer when both repositories are checked out side by side. The stack demo adds baseline-versus-candidate gating, evidence reports, review routing, and a verified redacted review bundle.

Use OTLP for generic collector and framework integration. Use the RAG trace contract when exact retrieval stages and page-level evidence must survive the handoff.
