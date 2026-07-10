# App Corpus Demo

This report is produced by `npm run corpus:app-demo -- --report`. It drives the same HTTP API used by the browser app: settings, document ingestion, eval question creation, query runs, state hydration, and run bundle export.

Run date: 2026-07-10T15:39:22.125Z

App state after run: 141 documents, 219 chunks, 22 eval questions, 22 runs.

Bundle check: raglens.run-bundle.v1 for run_062b7338bc10, with 5 evidence documents and 6 evidence chunks. Prompt text included: no.

## Summary

| Questions | Any Source Recall@K | All Source Recall@K | Source Recall@K | App Recall@K | MRR | Faithfulness | Citation Coverage | Expected Answer Coverage | Avg Citations |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 22 | 0.909 | 0.818 | 0.864 | 0.864 | 0.682 | 0.569 | 1.000 | 0.227 | 4.000 |

`App Recall@K` is RAGLens built-in recall for the first expected source saved with the eval question. The any/all source columns are added by this script for multi-source external questions.

## Sample Runs

| Corpus | Question | Top Source | Any Source Hit | Citation Coverage | Warnings |
| --- | --- | --- | --- | ---: | --- |
| SQuAD v1.1 dev | Which NFL team represented the AFC at Super Bowl 50? | SQuAD: Super_Bowl_50 #2 | yes | 1.000 | unsupported-claim, conflicting-sources |
| SQuAD v1.1 dev | Which NFL team represented the NFC at Super Bowl 50? | SQuAD: Super_Bowl_50 #2 | yes | 1.000 | unsupported-claim, conflicting-sources |
| SQuAD v1.1 dev | Where did Super Bowl 50 take place? | SQuAD: Super_Bowl_50 #4 | yes | 1.000 | expected-answer-mismatch, conflicting-sources |
| SQuAD v1.1 dev | Which NFL team won Super Bowl 50? | SQuAD: Super_Bowl_50 #1 | yes | 1.000 | unsupported-claim, expected-answer-mismatch, conflicting-sources |
| StratRAG validation | What role did Julianne Moore play in the 2002 Oscar winning movie? | StratRAG: The Hours (novel) (doc_00002000_07) | yes | 1.000 | expected-answer-mismatch |
| StratRAG validation | Ben Folds and Nic Offer are both considered to be which type of artists? | StratRAG: Ben Folds and WASO Live in Perth (doc_00002001_08) | yes | 1.000 | unsupported-claim, expected-answer-mismatch, conflicting-sources |
| StratRAG validation | Are both Days of the New and TV on the Radio from New York? | StratRAG: Ed Randall (doc_00002002_06) | yes | 1.000 | unsupported-claim, conflicting-sources |
| StratRAG validation | What is the name of the statue whose replica have been created in many landmarks world-wide such as near Pont de Grenelle in Paris? | StratRAG: Pont de Grenelle (doc_00002003_03) | yes | 1.000 | expected-answer-mismatch |
| SciFact dev | 0-dimensional biomaterials show inductive properties. | SciFact: ALDH1 is a marker of normal and malignant human mammary stem cells and a predictor of poor clinical outcome. | no | 1.000 | conflicting-sources |
| SciFact dev | 1,000 genomes project enables mapping of genetic sequence variation consisting of rare variants with larger penetrance effects than common variants. | SciFact: Mosaic PPM1D mutations are associated with predisposition to breast and ovarian cancer | yes | 1.000 | none |
| SciFact dev | 1/2000 in UK have abnormal PrP positivity. | SciFact: Prevalent abnormal prion protein in human appendixes after bovine spongiform encephalopathy epizootic: large scale survey | yes | 1.000 | conflicting-sources |
| SciFact dev | 5% of perinatal mortality is due to low birth weight. | SciFact: Intrauterine environments and breast cancer risk: meta-analysis and systematic review | no | 1.000 | unsupported-claim |

The broader benchmark-style corpus numbers live in `docs/corpus-evaluation.md`. This page is narrower on purpose: it demonstrates that external corpus data can move through the app/API workflow end to end.

