# Orchestrator

The orchestrator wires the pieces into the gate loop:

```
detect  →  predict  →  reveal  →  branch
```

It is the only component that touches all three extension points, and it owns the
resolution order that keeps Reckoner quiet by default.

## Resolution order (proposed)

For each proposed agent action:

1. **Detect** — run detectors → set of `DetectedTrigger`s (with `concepts`).
2. **Resolve config** — for each triggered category, look up `mode / depth / learningMode`.
   Drop anything set to `off`.
3. **Consult competence** — if `skipBelowFrontier`, drop triggers whose concepts are
   confidently below the user's frontier.
4. **Cap** — respect `gate.maxPromptsPerAction`; keep the highest-stakes trigger(s).
5. **Run the loop** for survivors:
   - `observe` → log only, never interrupt.
   - `coach` / `gate` → predict (if learningMode) → reveal (Explainer) → branch.
6. **Record** the outcome into the competence model.

The `branch` step is where `coach` (teach then allow) and `gate` (block until
understood) diverge — everything upstream is identical.

## Why it's its own module

Keeping the resolution order in one place makes the "silent by default" guarantee
auditable: there is exactly one path from an action to a gate, and every drop point
(off, below-frontier, cap) is visible in sequence.
