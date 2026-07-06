# Orchestrator

The orchestrator wires the pieces into the gate loop:

```
detect  →  predict  →  reveal  →  branch
```

It is the only component that touches all three extension points, and it owns the
resolution order that keeps Reckoner quiet by default.

## Resolution order (proposed)

For each proposed agent action:

1. **Detect** — Tier-0 deterministic detect (via the Resolver) → set of candidates
   (with `concepts`). Free, side-effect-free.
2. **Resolve config** — for each triggered category, look up `mode / depth / learningMode`.
   Drop anything set to `off`.
3. **Consult competence** — if `skipBelowFrontier`, drop triggers whose concepts are
   confidently below the user's frontier.
4. **Cap** — respect `gate.maxPromptsPerAction`; keep the highest-stakes trigger(s).
5. **Resolve content** — cards first (free), then the capsule provider if the
   profile's budget allows. Ordering matters: content may spend, so it runs only
   for candidates that survived every drop point. No content → downgrade to observe.
6. **Run the loop** for survivors:
   - `observe` → log only, never interrupt.
   - `coach` / `gate` → predict (selection by default; free-text only in deep
     mode) → reveal → branch.
7. **Record** the outcome into the competence model.

The `branch` step is where `coach` (teach then allow) and `gate` (block until
understood) diverge — everything upstream is identical.

## Why it's its own module

Keeping the resolution order in one place makes the "silent by default" guarantee
auditable: there is exactly one path from an action to a gate, and every drop point
(off, below-frontier, cap) is visible in sequence.
