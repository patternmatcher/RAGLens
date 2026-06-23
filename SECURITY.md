# Security

RAGLens is a local development tool. Do not expose it directly to the public internet without adding authentication and transport security.

See `docs/security-model.md` for the current control set and deployment notes.

## Data Handling

- Indexed document text is stored in `data/raglens.json`.
- API keys are not required for local mode. Optional provider keys are read from environment variables.
- Every run is persisted locally for inspection. Full prompt logging stays off unless enabled in Settings.

## RAG-Specific Risks

Retrieved text is treated as untrusted data. RAGLens scans retrieved chunks for prompt-injection-like phrases and surfaces warnings in the inspector. These warnings are heuristic and should not be treated as a complete security scanner.

## Reporting Issues

Open a GitHub issue with reproduction steps, expected behavior, and observed behavior. Do not include secrets or private documents in reports.
