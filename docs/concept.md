# Reckoner — Concept & Design

This document is the reasoning behind Reckoner. The README is the pitch; this is the
"why it's built this way." It exists so that every design decision is traceable to a
real failure mode.

## The thesis

We have extensive guardrails **for agents** and none **for humans**. The result is the
_agent-rider_: someone who approves consequential actions without understanding their
concept or consequence, and who gradually loses the ability to reason about the system
they're shipping.

Reckoner's job is to keep the human as the **engineer** — the one who understands — and,
optionally, to make building-with-an-agent a genuine way to learn.

The north-star metric is not "lines reviewed." It's **comprehension**: does the user
understand what they approved, and is their comprehension frontier moving over time?

## Two altitudes (do not conflate)

| | The gate (micro) | The map (macro) |
|---|---|---|
| **When** | At the moment of a consequential action | On demand, any time |
| **Form** | Interruptive: predict → reveal → branch | Queryable: "explain the system" |
| **Subject** | This one action's intent/mechanism/consequence | Whole-project wiring, protocols, concepts |
| **Gated?** | Yes (configurable) | Never |

Gating the macro view would be miserable; only mapping at the micro level would be too
shallow. They share the same knowledge engine but present completely differently.

## Design principle: concept-level, not diff-level

The subject of a gate is the reasoning chain, **not** the code:

```
intent      what the human asked for
   ↓
mechanism   how it will be wired — which protocols, tools, concepts
   ↓
consequence what changes, what could break, what it costs
```

Consequences of this choice:

- **Language-agnostic.** No per-language static analysis or AST parsing required.
- **Agent-native.** The agent already knows its own intent and mechanism; Reckoner
  forces that into an explicit, checkable form.
- **Honest.** It matches how people actually work with agents — at the level of
  functionality and consequence, not line-by-line.

## The gate loop

```
        ┌─────────┐     ┌─────────┐     ┌────────┐     ┌────────┐
action →│ detect  │ ──► │ predict │ ──► │ reveal │ ──► │ branch │→ approve / block / log
        └─────────┘     └─────────┘     └────────┘     └────────┘
             ▲               ▲                              │
             │               │                              │
        detectors +    (skipped if learning          competence model
        user config     mode off — plain             updated with the
                        explain instead)              prediction result
```

- **detect** — a detector classifies the action into one or more trigger categories.
  The user's config + the competence model decide whether this even fires.
- **predict** — ask the user to predict the consequence *before* revealing anything.
  This is the core learning lever.
- **reveal** — present intent → mechanism → consequence at the configured depth.
- **branch** — behavior set by the category's `mode` (see below).

## Trigger categories

The kinds of actions that _can_ fire a gate:

- **blastRadius** — reversibility / scope of damage: deletes, migrations, force-push,
  infra teardown.
- **security** — auth, secrets, permissions, network exposure.
- **cost** — paid APIs, provisioning, anything that spends money.
- **novelty** — concepts / protocols / tools new **to this user** (driven by the
  competence model, not a fixed list).
- **architecture** — cross-cutting changes; anything that alters how things are wired.

Detectors are pluggable so the community can add categories and refine classification.

## Gate behavior (`mode`)

Each category resolves to one mode:

- **off** — never fires.
- **observe** — never interrupts; silently records that the action happened and whether
  the user could have explained it (the _logged_ branch). Zero friction, pure signal.
- **coach** — runs predict → reveal, teaches on a wrong prediction, but **always** lets
  the user proceed. Friction with an escape hatch.
- **gate** — runs predict → reveal and **blocks** approval until the user demonstrates
  understanding. Maximum friction, maximum assurance.

`depth` controls how much reveal shows: `concept` · `consequence` · `wiring`.
`learningMode` toggles predict-then-reveal vs. plain explanation.

## The competence model (the moat)

The hard, defensible core. An evolving, **local** model of what the user already
understands. It does two jobs:

1. **Modulates every gate** — you're never gated below your frontier. This is what
   keeps Reckoner from patronizing experts (the fastest way to get uninstalled).
2. **Powers the education story** — "this user's comprehension frontier moved from X to
   Y" is the measurable proof that Reckoner turns riders into engineers.

Start dead-simple: a local JSON ledger of concepts seen and predictions
right/wrong. Keep it swappable so it can evolve toward real knowledge-tracing /
adaptive-difficulty (the same machinery behind Duolingo or Khan Academy). This is where
the interesting research contributions live.

## Failure modes → design commitments

Every commitment below exists to defuse a specific, named risk.

| Failure mode | Commitment |
|---|---|
| **Friction paradox** — agents exist to _remove_ friction; a gate adds it, so users disable it. | Silent by default. Gates fire only where they earn their keep, gated by config + competence model. |
| **Gaming / skim-through** — people skim explanations like they skim diffs. | Predict-then-reveal, not "more explanation." You must think before you're told. |
| **Patronizing experts** — gating someone below their level gets you uninstalled. | Competence model modulates every gate; never fire below the user's frontier. |
| **Altitude confusion** — one UX can't serve both per-action and whole-system understanding. | Separate gate (micro) from map (macro). |
| **Unclear wrong-answer behavior** — what happens when the user can't answer defines the whole product's personality. | Configurable per category: `coach` / `gate` / `observe`. |

## First-run setup = the config

Setup is not one slider; it's a small matrix of `category × {mode, depth, learningMode}`,
plus a global learning-mode toggle and the competence model. The three presets
(`learner`, `builder`, `expert`) are just starting points on that matrix. See
[config-schema.md](config-schema.md) for the full contract and
[`config/reckoner.jsonc`](../config/reckoner.jsonc) for a worked example.

## Open questions (tracked, not yet decided)

- **Form factor.** Prototype as a Claude Code hook + skill (the `PreToolUse` hook is
  already the exact interception point). Standalone cross-IDE product is the eventual
  vision, but not worth building until the core loop is proven non-annoying.
- **Comprehension scoring.** How the "reveal" judges a free-text prediction (LLM-judge
  vs. lighter structured checks) without becoming a graded exam.
- **Competence decay.** Does understanding a concept once mean you understand it
  forever? Probably not — how fast does the model let confidence decay?
