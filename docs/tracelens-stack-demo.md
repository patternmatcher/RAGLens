# TraceLens Stack Demo

This workflow demonstrates the boundary between the two projects with actual RAGLens runs rather than hand-authored TraceLens fixtures.

## Run

Place RAGLens and TraceLens next to each other and run:

```bash
npm run stack:demo
```

Use a different checkout with `--tracelens-dir=/path/to/tracelens`.

RAGLens loads its seeded document corpus and asks the same incident question twice. The baseline uses hybrid retrieval, reranking, and top-k 4. The candidate adds a stale incident summary, disables reranking, and lowers top-k to 1.

The candidate is well grounded in the wrong source. TraceLens therefore holds the release on retrieval recall even though groundedness and citation coverage look healthy:

```text
Baseline source: Incident Review 2026-05-14
Candidate source: Legacy Incident Summary
Retrieval recall: 1 -> 0
Groundedness: 0.85 -> 1
Citation coverage: 1 -> 1
Decision: HOLD
```

The command writes generated artifacts under `corpora/results/tracelens-stack-demo`. The directory includes the original OTLP payloads, normalized TraceLens traces, policy gates, replay and evidence reports, a review workflow, a root-cause report, a release decision, and a verified redacted review bundle. The directory is ignored by Git.
