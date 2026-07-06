# JARVIS MoA selector follow-through record

This record is for Bob's personal JARVIS/Hermes runtime fork only.

## Scope

- Owner/runtime: Bob / JARVIS
- Repository: `houenyang-momo/hermes-agent`
- Runtime branch: `jarvis-runtime`
- Patch commit: `f96006f0c4d3973ff9d244dac9f055810fdc9531`
- Upstream contribution: no

## What the local patch carries

- `/moa <prompt>` can prompt for configured presets when `moa.prompt_preset: true`.
- Explicit preset forms bypass the picker, including `/moa council ...`, `/moa council-opus48 ...`, `/moa --preset council ...`, and `/moa -p council ...`.
- Natural prompts keep their first word when it is not a configured preset.
- Slash-choice numeric normalization supports arbitrary-length preset menus.
- OpenAI/Codex Responses `reasoning_effort: max` is clamped to `xhigh` so Bob's GPT-5.5 route remains `xhigh` + `fast` instead of failing with OpenAI/Codex 400s.

## Local wrapper skill

Use local Hermes skill `hermes-moa-conductor` for Bob's MoA workflow. The skill treats MoA as a deliberation/recommendation lane while Hermes remains the root conductor for gated execution, verification, and final synthesis.

## Targeting rule

All work in this lane is for Bob/JARVIS by default. Do not open PRs against `NousResearch/hermes-agent` unless Bob explicitly requests an upstream contribution.

The accidental upstream PR `NousResearch/hermes-agent#59683` was closed and should remain closed.

## Verification evidence from setup

- Focused MoA/Codex tests: `94 passed`.
- Hermes launcher reported local carried commit `f96006f0` on top of upstream `7426c09b`.
- MoA config smoke confirmed:
  - default/active preset: `memory-openrouter-council`
  - `prompt_preset: true`
  - explicit preset parse: `('council-opus48', 'compare options')`
  - natural prompt parse: `(None, 'compare options')`
  - agent reasoning: `xhigh`
  - service tier: `fast`
