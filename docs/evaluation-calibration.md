# Evaluation Calibration

Run date: 2026-07-10T15:50:32.978Z

This run checks whether RAGLens evaluation metrics distinguish retrieved contexts that contain the expected source from controlled failures where every expected-source document has been removed.

The dataset contains 120 questions and 240 paired cases. Thresholds are selected on 186 cases and checked once on 54 held-out cases.

## Results

| Metric | Threshold | Validation AUC | Balanced Accuracy | Sensitivity | Specificity | False Positive Rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Runtime evidence quality | 0.604 | 0.580 | 0.593 | 0.407 | 0.778 | 0.222 |
| Retrieval confidence | 0.823 | 0.556 | 0.537 | 0.370 | 0.704 | 0.296 |
| Context relevance | 0.345 | 0.652 | 0.575 | 0.630 | 0.519 | 0.481 |
| Faithfulness | 0.887 | 0.471 | 0.537 | 0.259 | 0.815 | 0.185 |
| Citation coverage | 1.000 | 0.500 | 0.500 | 1.000 | 0.000 | 1.000 |
| Expected source recall@k | 0.500 | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 |
| Expected source MRR | 0.200 | 1.000 | 0.963 | 0.926 | 1.000 | 0.000 |
| Expected answer coverage | 1.000 | 0.655 | 0.650 | 0.450 | 0.850 | 0.150 |

## Corpus Coverage

| Corpus | Questions | Normal Source Hit Rate | Source-Removed Controls |
| --- | ---: | ---: | ---: |
| squad | 40 | 1.000 | 40 |
| stratrag | 40 | 0.925 | 40 |
| scifact | 40 | 0.925 | 40 |

## Reading The Numbers

- Runtime evidence quality is the geometric mean of retrieval confidence, context relevance, and faithfulness.
- Expected source recall and MRR are available only when an evaluation set supplies acceptable source names.
- Expected answer coverage is available only when an evaluation set supplies a reference answer.
- Citation coverage checks whether claims cite retrieved chunks. It does not prove that the retriever found the right source.
- Source names are used to create labels and negative controls. They are not inputs to the runtime evidence-quality score.

These thresholds are regression starting points for the bundled retrieval and evaluation heuristics. A deployment should recalibrate them with reviewed domain questions, real failure traces, and the exact embedding, reranking, and generation stack used in production.
