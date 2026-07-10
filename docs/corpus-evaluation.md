# Corpus Evaluation

This report is produced by `npm run corpus:eval -- --report`. Downloaded corpus files stay under `corpora/`, which is ignored by git.

Run date: 2026-07-10T15:39:19.596Z

Config: top-k 6, max claims 4, chunk tokens 120, overlap 24, question limit 80.

## Summary

| Corpus | Docs | Chunks | Questions | Any Source Recall@K | All Source Recall@K | Source Recall@K | MRR | Faithfulness | Citation Coverage | Expected Answer Coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SQuAD v1.1 dev | 6 | 7 | 80 | 1.000 | 1.000 | 1.000 | 0.781 | 0.601 | 1.000 | 0.669 |
| StratRAG validation | 900 | 754 | 60 | 0.950 | 0.617 | 0.783 | 0.791 | 0.689 | 1.000 | 0.561 |
| SciFact dev | 240 | 638 | 80 | 0.950 | 0.888 | 0.925 | 0.869 | 0.529 | 1.000 | 0.000 |

## Corpus Notes

- SQuAD checks clean single-passage Wikipedia question answering.
- StratRAG checks HotpotQA-derived multi-hop questions with distractor document pools.
- SciFact checks retrieval against scientific claim evidence documents.

These numbers are not meant to compete with benchmark leaderboards. They are a regression signal for this app: chunking, retrieval, citations, claim support, and report export should keep working on real external data.

## Sources

- SQuAD v1.1 dev: https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json
- StratRAG validation: https://datasets-server.huggingface.co/rows?dataset=Aryanp088%2FStratRAG&config=default&split=validation&offset=0&length=100
- SciFact dev: https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz

