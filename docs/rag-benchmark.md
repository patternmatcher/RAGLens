# Naive vs Enhanced RAG Benchmark

Suite: Enterprise operations golden set (60 cases, 12 documents)

Both profiles use 500-token chunks with 50-token overlap. The naive profile uses one keyword query with no reranking. The enhanced profile adds query expansion and decomposition, hybrid retrieval, a deeper candidate pool, reranking, metadata filters, and bounded parent context.

| Metric | Naive | Enhanced | Delta |
| --- | ---: | ---: | ---: |
| hitRateAtK | 0.963 | 1.000 | +0.037 |
| precisionAtK | 0.394 | 0.425 | +0.031 |
| recallAtK | 0.963 | 1.000 | +0.037 |
| mrr | 0.954 | 0.991 | +0.037 |
| ndcgAtK | 0.956 | 0.993 | +0.037 |
| faithfulness | 0.858 | 0.886 | +0.028 |
| citationCoverage | 0.963 | 1.000 | +0.037 |
| expectedAnswerCoverage | 0.960 | 0.997 | +0.037 |
| abstentionAccuracy | 0.967 | 1.000 | +0.033 |

## Runtime

| Profile | Average latency | P95 latency | Measured embedding cache hits | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Naive retrieval | 0.28 ms | 1.00 ms | 60 | 14267 | 3838 |
| Enhanced RAGLens retrieval | 0.33 ms | 1.00 ms | 64 | 17609 | 3892 |

## Gate

Passed.

The benchmark is a repository regression gate, not a claim about general model quality. It isolates changes in this corpus, chunking, retrieval, evidence selection, grounding, and abstention path.
