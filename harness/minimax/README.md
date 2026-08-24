# MiniMax Agent Project (MiniMax M3 Flagship & 1M Context Synthesis)

Dedicated harness and provider extension for MiniMax models via OAuth and Direct API Key.

## Models Supported

- `(oAuth) MiniMax-M3` (Flagship Reasoning & Multimodal Agent)
- `MiniMax-Text-01` (1M Context Window Long-Form Coding & Codebase Synthesis)
- `MiniMax-VL-01` (Multimodal Vision-Language Inspection)
- `abab6.5s-chat` (High-Throughput General Chat)

## File Layout

- `extensions/minimax.ts` — Provider registration & model catalog
- `lib/client.ts` — Stream client with eager HTTP/2 connection warm-up
- `lib/conversation-builder.ts` — Message normalization & tool call handling
- `lib/token-store.ts` — Dual-seam OAuth session ↔ MINIMAX_API_KEY fallback
- `lib/types.ts` — TypeScript definitions

## Performance Highlights

- **Persistent HTTP/2 Multiplexing**: Auto-warms `api.minimaxi.chat` for sub-200ms TTFT
- **Fast-Path Surrogate Sanitization**: Pre-screens multi-megabyte payloads for 1M context analysis
