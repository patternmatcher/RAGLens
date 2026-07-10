# Evaluation Notes

RAGLens keeps retrieval and answer evaluation separate. A bad user-facing answer can come from the retriever, the generator, or the citation/grounding layer, and each case needs a different fix.

## Retrieval Metrics

- `retrievalConfidence`: normalized top retrieval score.
- `contextRelevance`: average query-term coverage across retrieved chunks.
- `precisionAtK`: fraction of retrieved chunks matching any acceptable source when available.
- `recallAtK`: whether at least one acceptable source appeared in the retrieved set.
- `sourceRecallAtK`: fraction of acceptable sources represented in the retrieved set.
- `allSourceRecallAtK`: whether every acceptable source appeared in the retrieved set.
- `mrr`: reciprocal rank of the first expected-source chunk.
- `redundancy`: average overlap between retrieved chunks. Lower is better.

## Eval Checks

Eval checks are saved questions with an expected source document and optional expected answer note. The pipeline and corpus harness also accept an `expectedSources` array for questions where several documents are required or any one of several sources is acceptable. Source expectations calculate `precisionAtK`, `recallAtK`, `sourceRecallAtK`, `allSourceRecallAtK`, and `mrr`. The expected answer note is scored with deterministic key-term coverage so a run can retrieve the right document but still fail when it answers the wrong thing. Duplicate saved questions update the existing check instead of creating another copy.

## Calibration

Run `npm run eval:calibrate` after downloading the external corpora. The harness pairs each normal question with a negative control where every expected-source document is removed, assigns question pairs to deterministic calibration and validation splits, and selects thresholds using balanced accuracy.

The checked result in `docs/evaluation-calibration.md` shows why source-labeled evals matter. Runtime retrieval, context, faithfulness, and citation heuristics can look healthy when the system is grounded in the wrong document. Expected-source recall and MRR detect that failure because they use reviewed ground truth. Treat runtime scores as triage signals and source-labeled eval metrics as release evidence.

## Answer Metrics

- `faithfulness`: average claim support score.
- `citationCoverage`: percentage of claims with a citation.
- `answerFocus`: overlap between question terms and answer terms.
- `expectedAnswerCoverage`: percentage of expected-answer key terms present in the actual answer when an eval check includes an expected answer.

## Usage Metrics

- `inputTokens`, `outputTokens`, and `totalTokens`: estimated locally or reported by the live provider.
- `retrievalMs`, `generationMs`, and `evaluationMs`: per-stage latency.
- `estimatedCostUsd`: calculated from configured per-1M-token input/output rates. Local mode is treated as free, and live provider costs stay at zero until rates are configured by the operator.

## Claim Labels

- `supported`: the claim strongly overlaps with retrieved evidence.
- `partial`: the claim has some support but should be reviewed.
- `unsupported`: the claim is not grounded in retrieved context.

## Source Usage Heatmap

The inspector renders a claim-by-source matrix for each run. Rows are answer claims, columns are retrieved chunks, and cells use per-source support scores to show whether each cited source supports, partially supports, or fails to support the claim. The best uncited evidence match is outlined so reviewers can distinguish missing citations from missing evidence.

## Run Comparison

The Compare screen treats one run as a baseline and another as a candidate. It reports metric deltas, configuration changes, prompt template fingerprint/preview, chunking snapshot, answer text and claim counts, exact retrieved chunk overlap, stable source overlap, one-sided chunks, and warning types that were added or resolved.

Stable source overlap groups retrieved evidence by document and section, so chunk-size experiments stay readable even when reindexing creates new chunk ids. For chunk-size experiments, update chunk settings, reindex the active project with `POST /api/documents/reindex`, ask the same question again, then compare the baseline and candidate runs.

## Practical Thresholds

The default demo treats these as review signals:

- Retrieval confidence below `0.32`.
- Any unsupported claim.
- Expected-answer coverage below `0.45` when an eval check includes an expected answer.
- Retrieved chunks with stale/deprecated language mixed with current/active policy language.
- Redundancy above `0.38`.
- No retrieved context.

These are heuristics, not universal truth. Each score is tied to a visible run, retrieved chunks, and claim-level evidence.
