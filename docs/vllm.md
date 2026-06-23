# vLLM Setup

RAGLens can use vLLM as a local OpenAI-compatible chat provider. RAGLens still owns ingestion, chunking, retrieval, citations, evals, and the inspector. vLLM only receives the small set of retrieved chunks for each question.

## Start vLLM

Run vLLM on the machine with the GPU and keep it bound to localhost:

```bash
export VLLM_API_KEY="local-raglens-key"

docker run --rm --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  --env "HF_TOKEN=$HF_TOKEN" \
  vllm/vllm-openai:latest \
  --model Qwen/Qwen3-0.6B \
  --api-key "$VLLM_API_KEY" \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90
```

Check the server:

```bash
curl http://127.0.0.1:8000/health
curl -H "Authorization: Bearer local-raglens-key" http://127.0.0.1:8000/v1/models
```

The browser URL `http://127.0.0.1:8000/v1` may not render a useful page. For health checks, use `/health` or `/v1/models`.

## Run RAGLens Locally

When RAGLens is running directly on the host:

```bash
RAGLENS_OPENAI_BASE_URL=http://127.0.0.1:8000/v1
RAGLENS_OPENAI_API_KEY=local-raglens-key
RAGLENS_OPENAI_MODEL=Qwen/Qwen3-0.6B
npm run dev
```

If vLLM was started without `--api-key`, leave `RAGLENS_OPENAI_API_KEY` empty. RAGLens allows unauthenticated OpenAI-compatible calls only for local provider hosts such as `127.0.0.1`, `localhost`, and `host.docker.internal`.

In the app settings, choose:

- Provider: `openai-compatible`
- Model: the vLLM model name, for example `Qwen/Qwen3-0.6B`

## Run RAGLens With Docker Compose

When RAGLens runs in Docker and vLLM runs on the host, point RAGLens at Docker's host alias:

```bash
RAGLENS_ADMIN_TOKEN="$(openssl rand -hex 32)"
RAGLENS_OPENAI_BASE_URL=http://host.docker.internal:8000/v1
RAGLENS_OPENAI_API_KEY=local-raglens-key
RAGLENS_OPENAI_MODEL=Qwen/Qwen3-0.6B
docker compose up --build
```

The Compose file includes `host.docker.internal:host-gateway` so Linux Docker engines and WSL-backed Docker installs can resolve the host alias.

## Use a Big Corpus

For a larger corpus, use Postgres instead of the default JSON store:

```bash
RAGLENS_STORAGE_DRIVER=postgres
RAGLENS_DATABASE_URL=postgres://user:pass@host:5432/raglens
```

Apply `docs/database/postgres-pgvector.sql`, then ingest documents through the UI or through:

```bash
curl -X POST http://127.0.0.1:4177/api/ingestion-jobs \
  -H "Content-Type: application/json" \
  -H "X-RAGLens-Token: $RAGLENS_ADMIN_TOKEN" \
  -d '{"title":"Handbook","sourceType":"markdown","text":"# Handbook\n\n..."}'
```

RAGLens retrieves top chunks first, then sends only those chunks to vLLM. Do not try to send the whole corpus to vLLM as prompt context.

## Notes

- Keep vLLM bound to `127.0.0.1` unless it sits behind proper network controls.
- Use an API key for vLLM when any other process can reach the port.
- Retrieved chunks with prompt-injection-like or sensitive-data-like text are blocked from live provider egress by default.
- RAGLens currently uses local hash embeddings for deterministic inspection. For production semantic search, add an embedding provider adapter and size pgvector to the embedding model dimension.
