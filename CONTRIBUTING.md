# Contributing

Thanks for improving RAGLens.

## Local Checks

```bash
npm run build
npm run lint
npm test
```

## Pull Request Expectations

- Keep the app runnable without paid services.
- Add tests for chunking, retrieval, scoring, or API behavior when changing the pipeline.
- Preserve the inspector contract: every run should keep retrievable chunks, answer claims, metrics, warnings, and trace steps.
- Update `docs/` when behavior changes.

## Design Notes

RAGLens should feel like an engineering dashboard: dense, readable, and focused on debugging. Avoid landing-page patterns inside the app surface.
