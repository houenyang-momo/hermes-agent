# Multi-Agent Harness & Model Provider Architecture

This directory houses the dedicated project folders for all model provider extensions, agent harnesses, and network transport infrastructure for the Hermes & OMP agentic mesh.

## Harness Directory Structure

```
harness/
├── README.md                          # Master Harness Architecture & Specifications
├── common/                            # Shared Network, Connection Pooling & Wire Sanitizers
│   ├── stream-transport.ts           # Multiplexed ALPN HTTP/2 Transport with Sliding Watchdog
│   ├── http2-pool.ts                 # Persistent HTTP/2 Connection Pool & Session Management
│   ├── protocol-sanitizer.ts         # Fast-Path UTF-16 Surrogate & JSON Schema Sanitizer
│   ├── quota-store.ts                # Unified Cross-Provider Quota Store & TUI Badges
│   └── value-guards.ts               # Runtime Type & Value Assertion Utilities
├── gemini/                            # Dedicated Google Gemini (Cloud Code / Antigravity) Agent
│   ├── README.md                      # Gemini Architecture, Dialect Mapping & Benchmarks
│   ├── extensions/antigravity.ts      # Provider Registration Entrypoint & Model Catalog
│   └── lib/                           # Stream Engine, TokenStore, Test Suite & Benchmarks
├── claude/                            # Dedicated Anthropic Claude (Claude Code OAuth) Agent
│   ├── README.md                      # Claude Opus 5 / Sonnet 3.7 / Fable 5 Specifications
│   ├── extensions/claude.ts           # Provider Registration & Adaptive Thinking Mapping
│   └── lib/                           # Multi-Account Candidate Pool, TokenStore & Tests
├── minimax/                           # Dedicated MiniMax (M3 Flagship / Text-01) Agent
│   ├── README.md                      # MiniMax Specifications & 1M Context Synthesis
│   ├── extensions/minimax.ts          # Provider Registration & Model Specifications
│   └── lib/                           # TokenStore, Stream Client & Conversation Builder
├── codex/                             # Dedicated OpenAI Codex (ChatGPT Plus/Pro) Agent
│   ├── README.md                      # Codex Specifications & Quota Tracking
│   ├── quota.ts                       # Live Codex Quota Fetcher & Formatter
│   └── quota.test.ts                  # Regression Verification
└── xai/                               # Dedicated xAI Grok Agent
    ├── README.md                      # Grok 4.6 Specifications & TokenStore
    ├── token-store.ts                 # xAI API Key & Bearer Token Resolver
    └── index.ts                       # Module Entrypoint & Public Exports
```

## The 5-Layer Architectural Standard

Every dedicated agent project folder in `harness/` conforms to the 5-layer decoupled standard:

1. **Extension Entrypoint (`extensions/<provider>.ts`)**: Declarative provider registration, 64k/128k output catalog, model-aware thinking budget dialeting, eager origin warm-up, and auto-compaction error hooks.
2. **Stream Client Engine (`lib/client.ts`)**: EventStream lifecycle orchestration (`text_start`, `thinking_delta`, `toolcall_*`), zero-copy thoughtSignature preservation, and immediate SSE loop termination on finish reason.
3. **Protocol & Conversation Builder (`lib/conversation-builder.ts`)**: Bi-directional tool call ID normalization (`[a-zA-Z0-9_-]{1,64}`), native fast-path surrogate sanitization (`isWellFormed`), and unsupported JSON Schema keyword stripping.
4. **Network & Stream Transport (`../common/stream-transport.ts`)**: Persistent ALPN HTTP/2 connection pooling, single sliding 45s inactivity watchdog timer (zero `Promise.race` microtask churn), and cursor-based buffer parsing.
5. **Auth & Token Store (`lib/token-store.ts`)**: In-memory session check fast-path (0ms), in-flight `refreshPromise` mutex for parallel subagents, and dual-seam OAuth ↔ Direct API Key fallback.

## Universal Benchmark & Verification Standards

* **Zero-Reasoning TTFT**: `< 300 ms` on fast tool turns.
* **Streaming Throughput**: `> 1,000 chars/sec` (~250+ tokens/sec).
* **Subagent Concurrency**: Zero socket thrashing and zero token-mutex contention scaling to $N \ge 8$ parallel streaming workers.
* **Test Coverage**: 100% pass rate on unit, integration, and live streaming regression suites.
