# Security Model

RAGLens is a local developer tool. The default binding is `127.0.0.1`, and the app should not be exposed publicly without authentication, TLS, and a deployment-specific threat review.

## Current Controls

- Security headers are applied to API and static responses.
- Static file paths are resolved under `public/` and path traversal is rejected.
- Requests must use an allowed `Host` header. The default allowlist is `localhost`, `127.0.0.1`, `::1`, plus the configured bind host when it is not a wildcard. Use `RAGLENS_ALLOWED_HOSTS` for extra hostnames.
- Mutating API requests must use `Content-Type: application/json`.
- Non-loopback binds require a 32+ character `RAGLENS_ADMIN_TOKEN` unless explicitly overridden.
- When an admin token is configured, every JSON API route except `/api/health` must include `Authorization: Bearer <token>` or `X-RAGLens-Token`.
- Failed admin-token tracking has a fixed entry cap, expiration, and temporary backoff so attacker-controlled client addresses cannot grow process memory without bound.
- The browser UI stores the admin token only in `sessionStorage` and sends it as `X-RAGLens-Token` for same-origin API requests.
- Request bodies are capped at 1.5 MB.
- Indexed documents are capped at 200,000 characters.
- PDF uploads must have a PDF header, decoded PDF bytes are capped at 1 MB, and inflated PDF streams are bounded per stream and in aggregate before text extraction continues.
- Questions are capped at 2,000 characters.
- Workspace size is capped at 200 documents and 6,000 chunks.
- Likely API keys, access tokens, passwords, AWS access keys, and private key blocks are redacted before document text, document titles, query text, prompt templates, eval checks, and feedback are persisted.
- `/api/state` returns document metadata and previewable chunk evidence, but it does not include full document objects, raw embedding vectors, token terms, or term-count internals.
- OpenAI-compatible provider API keys are read from environment variables only and are not exposed in `/api/state`, workspace settings, run history, OTel exports, or browser storage.
- The optional Postgres `RAGLENS_DATABASE_URL` is read from environment variables only and is not exposed through the browser API.
- OpenAI-compatible provider base URLs reject embedded credentials, query strings, fragments, and non-HTTPS remote transport. HTTP is accepted only for loopback hosts and Docker host aliases unless `RAGLENS_ALLOW_UNSAFE_PROVIDER_HTTP=true` is set.
- Remote Postgres is rejected unless certificate-verified TLS is enabled or `RAGLENS_ALLOW_INSECURE_DATABASE_SSL=true` is explicitly set for an isolated local test network.
- Provider cost rates are optional operator-provided metadata and are exposed as non-secret configuration status in `/api/state`.
- OTLP export URLs reject embedded credentials, query strings, fragments, and non-HTTPS remote transport. HTTP is accepted only for loopback hosts unless `RAGLENS_ALLOW_UNSAFE_OTEL_HTTP=true` is set.
- OTLP collector headers are read from environment variables only and are never exposed in `/api/state`, run history, or browser storage. By default the exporter omits question text and fingerprints, query variants, warning details, document titles, sections, source URIs, prompts, answers, and claim text. Content is included only when `RAGLENS_OTEL_INCLUDE_CONTENT=true` is explicitly set.
- Remote provider and collector requests refuse redirects. Generation, embedding, query rewrite, reranking, web search, health, metrics, and corpus responses are bounded before parsing or persistence.
- Configured provider and web-search credentials are treated as known secrets and redacted if an upstream service reflects them in response content or metadata.
- Full prompt logging is off by default. When enabled for inspection, portable run bundles still omit the full prompt text.
- Optional external PDF text extraction is disabled by default. When `RAGLENS_PDF_TEXT_COMMAND` is configured, it must be an absolute path. RAGLens runs the trusted local binary without a shell, with a timeout, a temporary working directory, and a minimal environment that excludes RAGLens provider/admin secrets. It falls back to the internal parser on failure.
- Retrieved chunk bodies, document titles, headings, labels, sections, and source URIs are scanned for prompt-injection-like and sensitive-data-like language before generation.
- Live provider egress is blocked when retrieved chunks contain prompt-injection-like or sensitive-data-like text. RAGLens falls back to local generation unless a run explicitly sets `allowUnsafeProviderEgress=true`.
- Vector and embedding risks are tracked in the threat model: stale embeddings, mixed-version indexes, sensitive text in embeddings, and retrieval overexposure are treated as review concerns.
- Effective-date metadata and filters require real `YYYY-MM-DD` calendar dates. Invalid stored dates fail closed during JSON and Postgres filtering.
- JSON workspace writes are serialized per file, flushed, and atomically replaced from a unique same-directory temporary file.
- External corpus downloads use response and expansion limits plus pinned SHA-256 digests. Cached files are verified before reuse.
- The WSL vLLM bridge binds to loopback by default. Non-loopback binding requires `VLLM_API_KEY` unless the operator supplies the explicit isolated-network override.

## Non-Goals

- RAGLens is not a complete DLP scanner.
- RAGLens is not an authentication system.
- RAGLens does not stop users from indexing sensitive local documents.
- Prompt-injection detection is heuristic and should be treated as a review signal.
- Local hash embeddings are not a privacy boundary; do not index secrets or regulated data unless the local machine and data directory are approved for that material.
- Live provider mode can send retrieved chunks and prompts to the configured model endpoint; use local mode when documents cannot leave the machine. The default live-provider path blocks risky context egress before generation, but it is not a substitute for data classification.
- OTLP export sends model/provider metadata and trace step details to the configured collector; leave it disabled for fully local-only operation. Enabling `RAGLENS_OTEL_INCLUDE_CONTENT=true` can export raw questions.
- External PDF extraction executes the configured local binary against uploaded PDF bytes. Only configure trusted absolute-path binaries in trusted deployment images.

## Deployment Notes

For a public multi-user hosted version, add end-user authentication, per-user project isolation, TLS-only cookies, audit logging, and database-level access control before accepting third-party documents. The included Postgres adapter is meant for one trusted deployment instance, not open self-service tenancy.
