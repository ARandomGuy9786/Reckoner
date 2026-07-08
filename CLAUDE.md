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

- `config/reckoner.jsonc` + `reckoner.schema.json` — the behavior contract (schema v2).
  Categories (`blastRadius`, `security`, `cost`, `novelty`, `architecture`) × `mode`
  (`off`/`observe`/`coach`/`gate`) × `depth` × `learningMode`, plus the `resolver`
  section (per-session Tier-2 spawn cap + per-profile escalate/deep-mode policy). This
  is the product's soul; changes here are load-bearing.
- `cards/` — the authored comprehension-card library (Tier 1; zero tokens, forever).
  `cards/CLAUDE.md` is the authoring guide — card writing can be delegated there.
- `src/resolver.ts` — the tiered Resolver (T0 deterministic detect → T1 cards →
  T2 capsule provider) with profile policy and the budget guard. Unbudgeted LLM
  calls must stay structurally impossible.
- `src/detectors/deterministic.ts` — Tier-0 boundary patterns (tool identity +
  coarse args; never parsed code).
- `src/cards.ts` — card schema (zod) + JSONC loader; `npm run check:cards`.
- `src/capsule.ts` — the shared Tier-2 capsule contract: `CapsuleSchema` (zod), the
  generation prompt, and the card-shaping helpers. Both Tier-2 paths validate against
  this one definition — `engine.ts` (produces a capsule via the model) and the Claude
  Code hook (validates a capsule relayed from a spawned subagent), so they can't drift.
- `src/engine.ts` — Claude-backed Tier-2/3 provider (capsules for novel actions,
  deep-mode grading). Never on the default path.
- `src/orchestrator.ts` — the gate loop and the silent-by-default resolution order
  (detect → config → competence → cap → content). One auditable path from action
  to gate; content resolution (which may spend) comes last.
- `src/competence.ts` — the local competence ledger (the moat).
- `src/interactions.ts` — the append-only interaction log (`.reckoner/interactions.jsonl`;
  one line per gate outcome, fingerprinted, local-only). A swappable `InteractionLog` seam.
- `src/config.ts` — JSONC config loader (applies `resolver` defaults for v1 configs).
- `src/cli.ts` — the runnable test bench (`npm run demo`); default path is fully
  offline, `--deep` opts into Tier 3.
- `src/{detectors,explainers,competence,orchestrator}/README.md` — extension-point
  interfaces for contributors.
- `integrations/claude-code/` — the `PreToolUse` hook adapter (prototype). Runs the
  gate as the **deny-relay protocol** (hooks have no tty): deny carries the question,
  the agent relays it via AskUserQuestion, the answer comes back through
  `.reckoner/gate.answer`, grading is offline. For a novel boundary no card covers, a
  **round-0 capsule request** relays a subagent spawn (validated vs `capsule.ts`,
  cached per fingerprint, charged against a persisted per-session spawn budget in
  `.reckoner/spawns.json`). Never emits `allow` except for its own relay writes —
  passing a gate *defers* to the normal permission flow.
- `docs/` — `concept.md` (design + failure-mode→commitment map), `architecture.md`
  (build-shape decision record), `reference.md` (plain-English "how it all works"),
  `config-schema.md`.
- `.claude/hooks/pre-push-guard.sh` — the tests-before-push gate (wired in
  `.claude/settings.json`). Blocks `git push` when typecheck or card validation fails.

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

## Collaboration guardrails (with the maintainer)

These four are load-bearing for how sessions run. Hold them the way you hold the five
principles.

1. **Permission before building.** Propose the plan and get an explicit go-ahead before
   implementing. Reading, searching, and analysis are free; writing code/config/docs is
   what needs sign-off. When the shape is ambiguous, ask (few, crisp questions) first.
2. **Tests before push.** Never push to GitHub until `npm run typecheck` and
   `npm run check:cards` are green. This is enforced by `.claude/hooks/pre-push-guard.sh`,
   but treat the hook as a backstop, not a substitute for running them yourself.
3. **Docs-parity at every major upgrade.** When a change lands, leave the docs matching
   the code: CLAUDE.md layout, `docs/` (esp. `architecture.md` + `reference.md`), and the
   session handoff in `local/handoffs/`. A fresh session must be able to trust the docs as
   the current map — stale docs mis-steer the next session's direction.
4. **Explain in depth.** The maintainer wants to stay an engineer, not an agent-rider
   (this repo's whole thesis, applied to our own collaboration). Explanations should cover
   how it works, how it's wired, the tools/protocols/tasks and code concepts involved, and
   the pros/cons — with real-world analogies and comparisons. Default to teaching, not just
   reporting a result. Deep explanation is the norm here, not the exception.
