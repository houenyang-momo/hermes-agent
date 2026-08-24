# Claude Agent Project (Anthropic / Claude Code Enterprise OAuth)

Dedicated harness and provider extension for Anthropic Claude models via Claude Code OAuth.

## Models Supported

- `(oAuth) Claude Opus 5` (Flagship Reasoning & Architectural Synthesis, 128k output)
- `(oAuth) Claude Fable 5` (Ultra-Deep Code Review & Reasoning, 128k output)
- `(oAuth) Claude Opus 4.8 / 4.6` (Deep Systems Modeling & Verification)
- `(oAuth) Claude Sonnet 5 / 4.6` (Balanced Agentic Coding & Rapid Prototyping)
- `(oAuth) Claude Haiku 4.5` (Ultra-Fast Lightweight Tool Agent)

## File Layout

- `extensions/claude.ts` — Provider registration & thinking level mapping
- `lib/client.ts` — Stream orchestration & message conversion
- `lib/conversation-builder.ts` — Adaptive thinking budget & alternating turn collation
- `lib/transport.ts` — Eager HTTP/2 warm-up & beta header configuration
- `lib/token-store.ts` — Multi-account candidate pool, in-memory fast path & mutex
- `lib/quota.ts` — Live 5h / 7d usage limit tracking
- `lib/login.ts` — Interactive OAuth login workflow
- `lib/types.ts` — TypeScript definitions
- `lib/test-suite.ts` — 28-test regression suite (100% pass rate)

## Performance Highlights

- **In-Memory Candidate Pool Check**: 0ms token session probe, eliminating disk I/O on active sessions
- **Ephemeral Prompt Caching**: Automated `cache_control: { type: "ephemeral" }` on system prompts and tools
- **Adaptive Thinking**: Full support for 64k thinking budgets with accurate token accounting
