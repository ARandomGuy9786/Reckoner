# Reckoner — Architecture (decision record)

This is the settled architecture as of 2026-07-06, agreed after working through the
sustainability constraints. `concept.md` holds the product rationale; this file holds
the build shape. If a change contradicts a decision here, update this file in the same
PR and say why.

## The governing constraint

**Reckoner's default path must add ~zero marginal token cost and ~zero marginal
context to the user's session.** A comprehension tool that doubles the bill or bloats
the agent's context gets uninstalled — and an uninstalled tool teaches nobody. Every
architectural decision below traces back to this.

## Shape: harness + protocol, not an LLM engine

One integration-agnostic core, many thin adapters, joined by the `GateIO` seam:

```
CLI adapter        Claude Code hook        future adapters (IDEs, other agents)
      \                   |                   /
       ────────── GateIO seam ──────────────
                    (AgentAction in, decision out)
                          |
                    Orchestrator          ← silent-by-default pipeline:
                    /     |      \           detect → config → competence → cap
              Resolver  Competence  Config
                    \     |      /
                    .reckoner/ (local: ledger + interaction log)
```

The intelligence lives in a **tiered Resolver** that reaches for the cheapest source
first and only escalates when it must:

| Tier | Source | Cost | Role |
|---|---|---|---|
| 0 | **Deterministic detect** — tool identity + coarse args (`git push --force`, migration run, `rm -rf`, secret-path edit, deploy, spend) | zero | Decides whether anything fires at all. "Silent by default" is also "free by default". |
| 1 | **Authored comprehension cards** — community-built library keyed to recognized patterns | zero | The primary bet. Each card ships the predict question, selection options, consequence, concepts. A card authored once is a gate that never costs a token again. |
| 2 | **Spawned subagent** — isolated context, cheap model, small input; generates a card-shaped capsule for novel actions | user's existing session budget (bundled, no separate bill, no main-context pollution) | The novelty engine. Rare by construction, because Tiers 0–1 catch the recurring cases. |
| 3 | **Deep mode (opt-in)** — free-text prediction + LLM grading | explicit opt-in | Luxury for learners / high-stakes moments. Never the default. |

**Budget guard:** it must be structurally impossible for Reckoner to make an
unbudgeted LLM/subagent call. Spawn caps live in config; Tier ≥2 is unreachable when
the profile forbids it.

## Prediction format: selection, not free-text (decided)

The default predict-then-reveal is **multiple choice** — "what happens? (a)/(b)/(c)".
Grading is a string compare: zero LLM, zero tokens, one keypress of friction. It keeps
the thing that actually teaches (committing to a prediction *before* the reveal) at
~0% of the cost of free-text. Distractors are pedagogy: each wrong option encodes a
real misconception, so choosing wrong teaches something specific. Free-text + LLM
grading survives only as Tier-3 deep mode, and the competence model may weight a
free-text-correct higher than a selection-correct.

## Profiles drive the resolver (decided)

`profile` in the config doesn't just tune gate thresholds — it decides how
intelligence is sourced and spent:

| | Learner (education mode) | Builder (default) | Expert |
|---|---|---|---|
| Wants | To understand the system being built — learning is the product | Confidence at the moments that matter: build / commit / push / deploy | Awareness without interruption |
| Resolver | Cards first, subagent escalates readily; wiring depth; novelty gates on | Cards first, subagent rare (novel high-stakes only) | Cards only; never spends a token |
| Gate posture | More categories, `coach`, deeper reveals | `gate` on blastRadius/security at irreversible boundaries; quiet elsewhere | `observe` almost everywhere |
| Spend | Accepted — that's the tuition | Minimal, bounded | Zero |

**Boundary detection:** for the builder, Tier-0 keys on *irreversible moments*
(push, migration, deploy, delete, spend) — not per-edit. Edits are cheap to undo;
pushes aren't. This keeps the builder profile near-silent and near-free.

## Card format (schema'd in Phase 1 — `src/cards.ts` is authoritative)

A card is the unit of contribution. Shape as built:

```jsonc
{
  "id": "git-force-push",
  "title": "Force-push over remote history",
  "pattern": "git-force-push",     // keys to a built-in Tier-0 boundary pattern id, OR
  // "match": [{ "tool": "…", "args": "…" }],  // own coarse clauses — no code parsing
  "category": "blastRadius",
  "concepts": ["git-history-rewrite", "remote-divergence"],
  "mechanism": "…how it works, concept-level…",
  "consequence": "…what actually happens, incl. what cannot be undone…",
  "selection": {
    "question": "Teammates have commits on this branch. After the force-push, what happens to their work?",
    "options": [
      { "text": "…", "correct": true },
      { "text": "…", "misconception": "…why people believe this…" }
    ]
  }
}
```

Authoring guide (pedagogy, match-coarseness rules): `cards/CLAUDE.md`. Validation:
`npm run check:cards`.

## Claude Code integration (Phase 3 sketch)

`PreToolUse` hook. Tier-0 detect + card gates run **fully offline inside the hook**
(selection delivered via the hook's ask mechanism). Subagent escalation only for
novelty, per profile. The CLI remains the test bench for feeling and tuning cards.
The macro **map** ("explain the system", never gated) is deferred out of v1 entirely.

## Build phases

1. **Resolver core** — `Resolver` interface + profile policy; card schema + loader;
   starter pack (~10 boundary patterns: force-push, destructive migration, `rm -rf`,
   secret/env edits, auth changes, paid-API/provisioning, deploy, history rewrite);
   deterministic Tier-0 detect for the same patterns; demote current `engine.ts` to
   the Tier-2/3 provider behind the interface.
2. **Trust & measurement** — append-only interaction log (JSONL in `.reckoner/`);
   budget guard + per-session spawn caps; config schema v2 (`resolver` section +
   profile presets encoding the table above).
3. **First real adapter** — the `PreToolUse` hook as above.

The system's quality now lives in **card coverage and card quality** — which is
exactly where an OSS project wants it: contributors write cards, not infrastructure.
