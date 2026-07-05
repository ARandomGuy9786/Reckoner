# CLAUDE.md — Reckoner

Guidance for Claude Code working in this repo. Read [`docs/concept.md`](docs/concept.md)
for the full design rationale; this file is the short, load-every-session version.

## What this is

Reckoner is **comprehension guardrails for humans** — a layer that sits between an AI
agent's proposal and the human's approval and makes sure the human actually understands
what they're approving. The goal: keep the user an **engineer** (who understands the
system) rather than an **agent-rider** (who rubber-stamps a black box). Tagline: *not for
agents — for humans.*

## Five principles (do not let these drift)

1. **Silent by default.** The biggest risk is the *friction paradox* — a gate that fires
   when it isn't needed gets disabled, and then it's rubber-stamping with extra steps.
   Any change that makes gates fire more/harder must justify itself. When unsure, prefer
   `observe` over `coach`, and `coach` over `gate`.
2. **Concept-level, not diff-level.** The subject of a gate is the reasoning chain
   `intent → mechanism → consequence`, with code as *optional evidence*. No per-language
   AST parsing. This is deliberate and is what makes Reckoner language-agnostic.
3. **Predict-then-reveal, not more explanation.** People skim explanations exactly like
   they skim diffs. The core mechanic asks the user to *predict* a consequence before
   revealing it. Don't replace it with a passive info dump.
4. **Never gate below the user's frontier.** The competence model modulates every gate.
   Gating an expert on something they know is the fastest way to get uninstalled.
5. **Two altitudes stay separate.** The *gate* (micro, per-action, interruptive) and the
   *map* (macro, on-demand "explain the system", never gated) are different UX. Don't
   conflate them.

## Layout

- `config/reckoner.jsonc` + `reckoner.schema.json` — the behavior contract. Categories
  (`blastRadius`, `security`, `cost`, `novelty`, `architecture`) × `mode`
  (`off`/`observe`/`coach`/`gate`) × `depth` × `learningMode`. This is the product's
  soul; changes here are load-bearing.
- `src/engine.ts` — Claude-backed detector / explainer / grader.
- `src/orchestrator.ts` — the gate loop and the silent-by-default resolution order
  (detect → config → competence → cap). One auditable path from action to gate.
- `src/competence.ts` — the local competence ledger (the moat).
- `src/config.ts` — JSONC config loader.
- `src/cli.ts` — the runnable prototype (`npm run demo`).
- `src/{detectors,explainers,competence,orchestrator}/README.md` — extension-point
  interfaces for contributors.
- `integrations/claude-code/` — `PreToolUse` hook (the prototype target; not yet built).
- `docs/` — `concept.md` (design + failure-mode→commitment map), `config-schema.md`.

## Conventions

- **Model:** `claude-opus-4-8` is the engine default. Reckoner's *own* engine is an LLM
  app — when editing `engine.ts`, follow current Anthropic SDK/API guidance.
- **SDK note:** the engine prompts for strict JSON and validates with zod rather than
  using the structured-output helper, so it's robust across SDK versions. Keep it that
  way unless you're deliberately raising the SDK floor.
- **Privacy:** the competence ledger (`.reckoner/`) is local and must never be committed
  or transmitted. It's gitignored — keep it so.
- **TypeScript, ESM, strict.** Run `npm run typecheck` before committing.
- **Extension points are the contribution surface.** New capability usually means a new
  detector, explainer, or competence-model implementation behind its documented
  interface — not special-casing in the orchestrator.

## Working agreements

- Don't add features, abstractions, or config knobs beyond what a change needs.
- When a change affects gate behavior, state which failure mode it addresses and how it
  respects "silent by default" (mirror the CONTRIBUTING checklist).
- Keep the gate concept-level: if you find yourself parsing code structure to decide
  whether to gate, step back — that's the wrong altitude.
