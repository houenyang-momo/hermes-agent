# Gemini Agent Project (Google Cloud Code / Antigravity OAuth)

Dedicated harness and provider extension for Google Gemini models via Antigravity / Google Cloud Code OAuth.

## Models Supported

- `(oAuth) Gemini 3.7 Flash` (Flagship Hybrid Reasoning, 64k Output Window)
- `(oAuth) Gemini 3.7 Flash High / Medium / Low` (Tunable Thinking Budgets)
- `(oAuth) Gemini 3.6 Flash` (Fast Reasoning)
- `(oAuth) Gemini 3.5 Flash` (High-Throughput Subagent Worker)
- `(oAuth) Gemini 3.1 Pro` (Complex Architecture & Synthesis)
- `(oAuth) Gemini 3.1 Flash Lite` (Low-Latency Tool Execution)

## File Layout

- `extensions/antigravity.ts` — Provider registration & model catalog
- `lib/client.ts` — Streaming client & usage accounting
- `lib/conversation-builder.ts` — Model-aware thinking budget & tool call ID normalization
- `lib/transport.ts` — HTTP/2 transport & project ID loader
- `lib/token-store.ts` — In-memory token cache fast path & mutex
- `lib/quota.ts` — Live 5h / 7d quota tracking & UI badge formatting
- `lib/errors.ts` — Quota exhaustion & 429 backoff routing
- `lib/types.ts` — TypeScript definitions
- `lib/test-suite.ts` — 23-test regression suite (100% pass rate)
- `lib/profile-latency-tools.ts` — Latency, jitter & throughput profiling tool
- `lib/gauntlet-benchmark.ts` — Benchmark runner

## Performance Highlights

- **Zero-Reasoning TTFT (`reasoning: "off"`)**: ~220 ms (15x faster via `thinkingBudget: 0`)
- **Pro Model Compatibility**: Automatically omits `thinkingConfig` to prevent HTTP 400 crashes
- **Throughput**: 1,025 chars/sec (~256 tokens/sec)
- **Subagent Concurrency**: Verified 100% success rate across $N=1, 3, 5, 8$ concurrent streams in 3.5s total wall time
