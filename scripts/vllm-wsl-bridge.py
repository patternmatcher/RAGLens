#!/usr/bin/env python3
import argparse
import hmac
import json
import math
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 1024 * 1024
MAX_OUTPUT_TOKENS = 256
MAX_MESSAGES = 32
MAX_MESSAGE_CHARS = 65_536
MAX_TOTAL_MESSAGE_CHARS = 131_072


def parse_args():
    parser = argparse.ArgumentParser(description="Local OpenAI-compatible bridge for a vLLM engine under WSL.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--served-model-name", default="local-vllm")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-model-len", type=int, default=2048)
    parser.add_argument("--max-num-seqs", type=int, default=1)
    parser.add_argument("--max-num-batched-tokens", type=int, default=2048)
    parser.add_argument("--gpu-memory-utilization", type=float, default=0.88)
    return parser.parse_args()


class Runtime:
    def __init__(self, args):
        from vllm import LLM, SamplingParams

        started = time.perf_counter()
        self.model_name = args.served_model_name
        self.max_model_len = args.max_model_len
        self.api_key = os.environ.get("VLLM_API_KEY", "")
        self.llm = LLM(
            model=args.model,
            served_model_name=args.served_model_name,
            dtype="half",
            quantization="bitsandbytes",
            load_format="bitsandbytes",
            max_model_len=args.max_model_len,
            max_num_seqs=args.max_num_seqs,
            max_num_batched_tokens=args.max_num_batched_tokens,
            gpu_memory_utilization=args.gpu_memory_utilization,
            enforce_eager=True,
            enable_chunked_prefill=False,
            enable_prefix_caching=False,
        )
        self.sampling_params_class = SamplingParams
        self.tokenizer = self.llm.get_tokenizer()
        self.lock = threading.Lock()
        self.started_at = time.time()
        self.load_seconds = time.perf_counter() - started
        self.requests = 0
        self.failures = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.generation_seconds = 0.0

    def generate(self, messages, temperature, max_tokens):
        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_tokens = self.tokenizer(prompt, add_special_tokens=False)["input_ids"]
        if len(prompt_tokens) + max_tokens > self.max_model_len:
            raise ValueError(
                f"Prompt and output limit exceed the {self.max_model_len}-token model context."
            )
        sampling = self.sampling_params_class(
            temperature=max(0.0, min(float(temperature), 2.0)),
            max_tokens=max(1, min(int(max_tokens), MAX_OUTPUT_TOKENS)),
        )
        started = time.perf_counter()
        with self.lock:
            result = self.llm.generate([prompt], sampling)[0]
        duration = time.perf_counter() - started
        output = result.outputs[0]
        prompt_tokens = len(result.prompt_token_ids or [])
        output_tokens = len(output.token_ids or [])
        self.requests += 1
        self.input_tokens += prompt_tokens
        self.output_tokens += output_tokens
        self.generation_seconds += duration
        return output.text.strip(), prompt_tokens, output_tokens, duration, output.finish_reason


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, server_address, handler_class, max_connections=32):
        self.connection_slots = threading.BoundedSemaphore(max_connections)
        super().__init__(server_address, handler_class)

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()


def make_handler(runtime):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RAGLens-vLLM-WSL-Bridge/1"

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"ok": True, "model": runtime.model_name})
                return
            if self.path == "/v1/models":
                if not self.authorized():
                    return
                self.send_json(200, {
                    "object": "list",
                    "data": [{"id": runtime.model_name, "object": "model", "owned_by": "local"}],
                })
                return
            if self.path == "/metrics":
                if not self.authorized():
                    return
                self.send_metrics()
                return
            self.send_json(404, {"error": {"message": "Not found."}})

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_json(404, {"error": {"message": "Not found."}})
                return
            if not self.authorized():
                return
            try:
                payload = self.read_json()
                if payload.get("model") not in {None, "", runtime.model_name}:
                    raise ValueError(f"model must be {runtime.model_name}.")
                if payload.get("stream") is True:
                    raise ValueError("Streaming responses are not supported by this local bridge.")
                messages = payload.get("messages")
                if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
                    raise ValueError(f"messages must contain 1 to {MAX_MESSAGES} items.")
                normalized = []
                total_chars = 0
                for message in messages:
                    if not isinstance(message, dict):
                        raise ValueError("Each message must be an object.")
                    role = message.get("role", "")
                    content = message.get("content", "")
                    if not isinstance(role, str) or not isinstance(content, str):
                        raise ValueError("Each message role and content must be strings.")
                    role = role.strip()
                    if role not in {"system", "user", "assistant"} or not content:
                        raise ValueError("Each message requires a supported role and content.")
                    if len(content) > MAX_MESSAGE_CHARS:
                        raise ValueError(f"Each message is limited to {MAX_MESSAGE_CHARS} characters.")
                    total_chars += len(content)
                    if total_chars > MAX_TOTAL_MESSAGE_CHARS:
                        raise ValueError(f"Message content is limited to {MAX_TOTAL_MESSAGE_CHARS} characters.")
                    normalized.append({"role": role, "content": content})
                temperature = finite_float(payload.get("temperature", 0), "temperature")
                if temperature < 0 or temperature > 2:
                    raise ValueError("temperature must be between 0 and 2.")
                max_tokens = bounded_integer(
                    payload.get("max_tokens", 128),
                    "max_tokens",
                    1,
                    MAX_OUTPUT_TOKENS,
                )
                text, prompt_tokens, output_tokens, duration, finish_reason = runtime.generate(
                    normalized,
                    temperature,
                    max_tokens,
                )
                self.send_json(200, {
                    "id": f"chatcmpl-{uuid.uuid4().hex}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": runtime.model_name,
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": finish_reason or "stop",
                    }],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": output_tokens,
                        "total_tokens": prompt_tokens + output_tokens,
                    },
                    "local_metrics": {"generation_seconds": round(duration, 3)},
                })
            except ValueError as error:
                runtime.failures += 1
                self.send_json(400, {"error": {"message": str(error)}})
            except Exception:
                runtime.failures += 1
                self.send_json(500, {"error": {"message": "Local generation failed."}})

        def authorized(self):
            if not runtime.api_key:
                return True
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {runtime.api_key}"
            if hmac.compare_digest(supplied, expected):
                return True
            self.send_json(401, {"error": {"message": "Authentication required."}})
            return False

        def read_json(self):
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if content_type != "application/json":
                raise ValueError("Content-Type must be application/json.")
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_BODY_BYTES:
                raise ValueError(f"Request body must contain 1 to {MAX_BODY_BYTES} bytes.")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
            return payload

        def send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def send_metrics(self):
            elapsed = max(runtime.generation_seconds, 0.000001)
            model_label = runtime.model_name.replace('\\', '\\\\').replace('"', '\\"')
            lines = [
                "# TYPE raglens_vllm_bridge_requests_total counter",
                f"raglens_vllm_bridge_requests_total {runtime.requests}",
                "# TYPE raglens_vllm_bridge_failures_total counter",
                f"raglens_vllm_bridge_failures_total {runtime.failures}",
                "# TYPE raglens_vllm_bridge_output_tokens_total counter",
                f"raglens_vllm_bridge_output_tokens_total {runtime.output_tokens}",
                "# TYPE raglens_vllm_bridge_tokens_per_second gauge",
                f"raglens_vllm_bridge_tokens_per_second {runtime.output_tokens / elapsed:.6f}",
                "# TYPE raglens_vllm_bridge_load_seconds gauge",
                f"raglens_vllm_bridge_load_seconds {runtime.load_seconds:.6f}",
                "# TYPE vllm_prompt_tokens_total counter",
                f'vllm_prompt_tokens_total{{model_name="{model_label}"}} {runtime.input_tokens}',
                "# TYPE vllm_generation_tokens_total counter",
                f'vllm_generation_tokens_total{{model_name="{model_label}"}} {runtime.output_tokens}',
                "# TYPE vllm_request_decode_time_seconds counter",
                f'vllm_request_decode_time_seconds{{model_name="{model_label}"}} {runtime.generation_seconds:.6f}',
                "# TYPE vllm_e2e_request_latency_seconds counter",
                f'vllm_e2e_request_latency_seconds{{model_name="{model_label}"}} {runtime.generation_seconds:.6f}',
                "# TYPE vllm_num_requests_running gauge",
                f'vllm_num_requests_running{{model_name="{model_label}"}} 0',
                "# TYPE vllm_num_requests_waiting gauge",
                f'vllm_num_requests_waiting{{model_name="{model_label}"}} 0',
                "",
            ]
            body = "\n".join(lines).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format_string, *args):
            print(f"{self.address_string()} {format_string % args}", flush=True)

    return Handler


def finite_float(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a finite number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a finite number.") from error
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number.")
    return number


def bounded_integer(value, label, minimum, maximum):
    if isinstance(value, bool):
        raise ValueError(f"{label} must be an integer between {minimum} and {maximum}.")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be an integer between {minimum} and {maximum}.") from error
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{label} must be an integer between {minimum} and {maximum}.")
    if number < minimum or number > maximum:
        raise ValueError(f"{label} must be an integer between {minimum} and {maximum}.")
    return number


def main():
    args = parse_args()
    if args.max_model_len < 256:
        raise SystemExit("--max-model-len must be at least 256.")
    if args.max_num_seqs < 1:
        raise SystemExit("--max-num-seqs must be positive.")
    if args.max_num_batched_tokens < args.max_model_len:
        raise SystemExit("--max-num-batched-tokens must be at least --max-model-len.")
    if not 0 < args.gpu_memory_utilization <= 1:
        raise SystemExit("--gpu-memory-utilization must be greater than 0 and at most 1.")
    runtime = Runtime(args)
    print(json.dumps({
        "status": "ready",
        "model": runtime.model_name,
        "loadSeconds": round(runtime.load_seconds, 3),
        "host": args.host,
        "port": args.port,
    }), flush=True)
    server = BoundedThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    server.serve_forever()


if __name__ == "__main__":
    main()
