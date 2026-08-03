# Release Checklist

Run this before publishing a release or tag:

```bash
npm run doctor
npm run doctor -- --strict # for tags/releases on machines with Git and Docker
npm run preflight
npm run eval:calibrate
npm run corpus:eval -- --report=docs/corpus-evaluation.md # after npm run corpus:fetch has populated corpora/
npm run corpus:app-demo -- --report=docs/app-corpus-demo.md
npm run stack:demo # with TraceLens cloned beside RAGLens
npm run postgres:export -- --demo
npm run release:audit -- --json
```

Manual checks:

- Start the app with `npm run dev` or `npm start`, then open the reported local URL. The default is `http://127.0.0.1:4177`.
- Review `docs/implementation-matrix.md` and confirm any Partial/External rows are still accurate.
- Confirm the dashboard loads with demo documents and chunks.
- Queue a small document from the Documents screen and confirm the job completes without exposing source text in the job payload.
- Try selecting an oversized text/PDF file and confirm the browser rejects it before upload.
- Run a workbench query.
- Inspect retrieved chunks, claims, warnings, and trace steps.
- Add a small document containing a fake token and confirm it is redacted.
- Upload a simple PDF and confirm Settings reports the expected PDF parser mode; if `RAGLENS_PDF_TEXT_COMMAND` is configured, confirm extraction falls back cleanly when the command is unavailable.
- Run one eval question and confirm precision@k, any-source recall@k, source recall@k, all-source recall@k, MRR, claim heatmap, and citation links render.
- Run `npm run eval:calibrate` and review the held-out validation results in `docs/evaluation-calibration.md` before changing runtime warning thresholds.
- If external corpora are available locally, run `npm run corpus:eval -- --report=docs/corpus-evaluation.md` and review the SQuAD, StratRAG, and SciFact summary table.
- Run `npm run corpus:app-demo -- --report=docs/app-corpus-demo.md` and confirm it indexes external docs through the app API, creates eval checks, runs queries, and exports a bundle.
- With TraceLens cloned beside RAGLens, run `npm run stack:demo` and confirm both traces pass import, release-gate, and redacted bundle checks.
- On a machine with a compatible local vLLM model, use `npm run stack:open-weight` for the live model, corpus, collector, and gate path. Keep generated evidence under ignored `corpora/results/`.
- Copy a share link and confirm it reopens the same run.
- Compare two runs of the same question and confirm the picker labels distinguish timestamp/config, and the comparison shows metric, config, answer, retrieval, and warning deltas.
- Download a Run Bundle from the Inspector and confirm the JSON contains `raglens.run-bundle.v1`, retrieved evidence chunks, source metadata, and no full source document text, embedding vectors, or term-count internals.
- If `RAGLENS_ADMIN_TOKEN` is set, confirm `/api/state` returns 401 without a token and the browser loads data after setting the token in Settings or responding to the token prompt.
- Confirm `README.md` still reflects the current UI.
- If Docker is installed, run `npm run docker:runtime`. You can also set `RAGLENS_ADMIN_TOKEN` in a local `.env`, run `docker compose up --build`, and confirm `/api/health` returns `{ "ok": true }`.
- For release tags, run `RAGLENS_REQUIRE_DOCKER=1 npm run docker:runtime` or use CI so the Docker runtime check is required.
- For hosted persistence review, apply `docs/database/postgres-pgvector.sql` in a Postgres database with pgvector, install the optional `pg` package in the deployment image, and run once with `RAGLENS_STORAGE_DRIVER=postgres`, `RAGLENS_DATABASE_URL`, and `RAGLENS_DATABASE_SSL=true`. Apply the output from `npm run postgres:export -- --demo` if you want demo seed data.

Repository checks:

- No generated `data/`, `data-*`, or `corpora/` folders are committed.
- `npm run doctor` has no errors. Use `npm run doctor -- --strict` before publishing a tag or archive. Non-strict Git/Docker warnings are fine when those tools are not installed locally.
- No real secrets are committed.
- Screenshot in `docs/assets/dashboard.png` is current enough for the README.
- CI includes Node 22.12 and Node 24 coverage for build, lint, tests, HTTP/API flows, production entrypoint, browser rendering, Docker checks, API/Postgres contracts, release audit, and RAG evals.
