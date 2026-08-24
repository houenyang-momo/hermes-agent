# OMP Agent / Gemini OAuth Extension (Antigravity Google Cloud Code)

Production-grade, zero-stall, ultra-low-latency Google Gemini OAuth provider extension for Oh My Pi (OMP) and Pi Agent (`@earendil-works/pi-agent`).

## Canonical Locations

- **Extension Entrypoint:** `extensions/antigravity.ts` (Registers `antigravity` / Gemini models in OMP/Pi)
- **Cloud Code Core Library:** `lib/cloudcode/`
  - `client.ts` — EventStream orchestration & lifecycle
  - `conversation-builder.ts` — Model-aware thinking budget & tool call ID normalization
  - `transport.ts` — HTTP/2 stream transport & project ID loader
  - `token-store.ts` — In-memory fast path, token mutex & Keychain/Linux storage
  - `quota.ts` — Live 5h / 7d quota tracking & UI badge formatting
  - `errors.ts` — Quota exhaustion & 429 backoff routing
  - `types.ts` — TypeScript interfaces & contracts
  - `test-suite.ts` — Automated 23-test regression suite
  - `profile-latency-tools.ts` — Latency, jitter & throughput profiling tool
  - `gauntlet-benchmark.ts` — Head-to-head TTFT & chars/sec benchmark
- **Common Network & Sanitizer Layer:** `lib/common/`
  - `stream-transport.ts` — ALPN HTTP/2 multiplexed transport with sliding watchdog
  - `http2-pool.ts` — Connection pooling & stream management
  - `protocol-sanitizer.ts` — Fast-path Unicode surrogate sanitizer (`isWellFormed`)
  - `quota-store.ts` — Unified cross-provider quota store

## Verification & Benchmarks

Run the test suite:
```bash
bun run lib/cloudcode/test-suite.ts
```

Run latency & streaming throughput benchmark:
```bash
bun run lib/cloudcode/profile-latency-tools.ts
```
