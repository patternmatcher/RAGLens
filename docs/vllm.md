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
  vllm/vllm-openai:v0.21.0 \
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

## Docker Inside WSL Fallback

Some Docker-inside-WSL installations force vLLM workers to use Python's `spawn` process mode. If the official API process exits without an application error during model startup, `scripts/vllm-wsl-bridge.py` provides a small diagnostic OpenAI-compatible server around the proven `vllm.LLM` engine path.

Keep the container attached while a model loads from a Windows-mounted drive. On some setups, a detached Docker workload does not keep the WSL distribution active during a long cold start.

```bash
docker run --rm -it --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 \
  -v '/mnt/d/Test area/Local LLMs/models:/models:ro' \
  -v "$PWD/scripts/vllm-wsl-bridge.py:/opt/vllm-wsl-bridge.py:ro" \
  --entrypoint python3 \
  vllm/vllm-openai:v0.21.0 \
  /opt/vllm-wsl-bridge.py \
  --model /models/Llama-3.1-8B-Instruct \
  --served-model-name Llama-3.1-8B-Instruct \
  --max-model-len 2048 \
  --gpu-memory-utilization 0.88
```

Set `VLLM_API_KEY` on the container when anything outside the local user session can reach it. The bridge limits request bodies and output tokens, serializes generation, omits prompts from logs, and exposes only health, model, completion, and bounded metrics routes. It is a compatibility and validation tool, not a replacement for vLLM's production API server.

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

Run the checked RAGLens to TraceLens path after the model is healthy:

```bash
npm run corpus:fetch
npm run stack:open-weight -- --corpus=stratrag --model=Llama-3.1-8B-Instruct
```

The command refuses to count a local fallback as a live result. It queries a safe question from the external corpus, exports redacted OTLP through TraceLens's authenticated collector, runs the release gate, and writes generated evidence under ignored `corpora/results/open-weight-stack`.

## Notes

- Keep vLLM bound to `127.0.0.1` unless it sits behind proper network controls.
- Use an API key for vLLM when any other process can reach the port.
- Retrieved chunks with prompt-injection-like or sensitive-data-like text are blocked from live provider egress by default.
- RAGLens currently uses local hash embeddings for deterministic inspection. For production semantic search, add an embedding provider adapter and size pgvector to the embedding model dimension.
