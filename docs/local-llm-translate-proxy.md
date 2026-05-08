# Local LLM translation proxy

`tools/local-llm-translate-proxy.mjs` adapts EdgeTranslate's `LocalTranslate` endpoint contract to any OpenAI-compatible `/v1/chat/completions` server, including `llama-server`.

## Recommended Gemma 4 E2B llama-server

```bash
/home/ubuntu/.local/bin/llama-server \
  --host 127.0.0.1 \
  --port 8090 \
  --no-webui \
  --model /home/ubuntu/.hermes/models/unsloth-gemma-4-e2b-it-gguf/gemma-4-E2B-it-Q4_K_M.gguf \
  --ctx-size 4096 \
  --threads 4 \
  --threads-batch 4 \
  --gpu-layers 0 \
  --parallel 1 \
  --batch-size 1024 \
  --ubatch-size 512 \
  --cache-ram 0 \
  --jinja \
  --no-warmup
```

## Start the proxy

```bash
OPENAI_BASE_URL=http://127.0.0.1:8090 \
OPENAI_MODEL=gemma4-e2b-q4 \
PORT=8091 \
CHUNK_CHARS=1400 \
MAX_CONCURRENCY=1 \
node tools/local-llm-translate-proxy.mjs
```

Health check:

```bash
curl http://127.0.0.1:8091/health
```

Translation request:

```bash
curl -s http://127.0.0.1:8091/translate \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","source_language":"English","target_language":"Korean"}'
```

## EdgeTranslate settings

- Local translator: enabled
- Local mode: endpoint
- Endpoint: `http://127.0.0.1:8091/translate`
- Timeout: `120000`
- Default page translator: `Local Translator Page Translate`

## Tuning notes

For a 4-core CPU llama-server, keep the proxy and extension concurrency low:

- `MAX_CONCURRENCY=1`
- `CHUNK_CHARS=1000~1600`
- llama-server `--parallel 1`

This favors perceived responsiveness: the extension replaces completed page blocks progressively instead of waiting for a whole page translation to finish.
