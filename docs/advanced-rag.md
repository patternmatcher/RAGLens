# Advanced Retrieval

RAGLens keeps the local demo deterministic, but each expensive retrieval stage has a provider boundary for production use. Every stage records its inputs, selected evidence ids, latency, provider, model, cache status, and configuration in the exported RAG trace.

## Retrieval Path

1. The query planner rewrites the question, expands known abbreviations, detects ambiguity, and decomposes compound questions.
2. The embedding provider returns one vector for each search query. Cache keys include the project, provider, model, and a SHA-256 digest of the text.
3. Metadata filters restrict eligible documents before scoring.
4. Sparse BM25-style and dense cosine candidates are ranked independently.
5. Hybrid mode fuses candidate ranks across query variants.
6. The configured reranker selects the final child chunks.
7. Parent retrieval can add neighboring chunks from the same section within a token budget. Ranking metrics continue to use the selected child chunks.
8. The answer path either generates from the selected context, uses an approved web fallback, or abstains.

## Provider Contracts

### Embeddings

Set `RAGLENS_EMBEDDING_PROVIDER=openai-compatible` and configure the base URL, model, and optional API key. The endpoint must implement `POST /embeddings` with the OpenAI-compatible indexed response shape. Remote document and query egress is disabled until `RAGLENS_ALLOW_REMOTE_EMBEDDING_EGRESS=true` is set.

All remote adapters refuse redirects and enforce response-size limits before parsing. A provider that needs redirection must be configured with its final trusted endpoint.

Stored chunks record the embedding provider, model, and dimension. A deployment model change causes the affected chunks to be re-embedded. Dense retrieval ignores vectors from an incompatible model or dimension instead of comparing invalid profiles.

### Reranking

`RAGLENS_RERANKER_PROVIDER=http` sends the query and indexed candidate documents to `POST /rerank`. Responses may return `index` with `relevance_score` or `score`. `RAGLENS_RERANKER_PROVIDER=colbert` uses the same transport contract and records the stage as late interaction in the shared trace.

Provider failure is visible as a run warning and falls back to the deterministic local reranker. Candidate content with injection or sensitive-data signals remains local unless the individual run explicitly permits provider egress.

### Query Planning

The local planner is deterministic and handles common RAG and operations vocabulary. An OpenAI-compatible planner may return structured JSON containing `rewrittenQuery`, `expansions`, `subqueries`, `ambiguous`, and `ambiguityReason`. Provider errors fall back to local planning and remain visible in the run.

## Metadata Filters

Documents accept these allow-listed metadata fields:

- `collection`
- `department`
- `version`
- `effectiveDate`
- `sensitivity`
- `sourceUri`
- `tags`

Queries can filter by document ids, source types, collections, departments, versions, tags, sensitivities, effective date bounds, and page bounds. Values are normalized by the API before reaching the in-memory or parameterized Postgres retrieval path. Effective dates must be real calendar dates in `YYYY-MM-DD` form. Malformed filter input is rejected, and malformed stored dates never match a date-bounded query.

## Web Fallback

Web fallback is off by default. When enabled, it runs only after low-confidence retrieval and uses a SearXNG-compatible JSON endpoint. RAGLens does not fetch result pages. It indexes only the snippets returned by the configured search service for the current run.

Production deployments should set `RAGLENS_WEB_SEARCH_ALLOWED_DOMAINS`. TraceLens rejects web fallback in the enterprise gate when the trace does not record an allowlist. Queries that request secrets, payroll data, or policy bypasses abstain without web fallback.

## Evaluation

Run the checked suite with:

```bash
npm run eval:golden
```

Regenerate the comparison artifact and report with:

```bash
npm run benchmark:rag
```

The suite contains 60 cases across 12 enterprise documents. It includes metadata scope, stale versions, ambiguity, multiple required sources, abbreviation expansion, unsupported questions, and adversarial requests. The release gate checks case count, hit rate, MRR, NDCG, citation coverage, abstention behavior, and regression against the naive profile.

Benchmark latency is useful for deterministic local regression checks, not hardware capacity planning. Run the corpus and open-weight scripts against the target model, GPU, database, and collector before setting deployment SLOs.
