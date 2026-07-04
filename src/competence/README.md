# Competence model

The competence model is Reckoner's moat: an evolving, **local** estimate of what the
user already understands. It answers one question at gate time — _"is this concept above
this user's frontier, and therefore worth a gate?"_ — and it produces the education
signal that proves Reckoner is working.

## Two jobs

1. **Modulate gates.** With `skipBelowFrontier`, a gate is suppressed when the user has
   reliably understood the concept before. This is what stops Reckoner from patronizing
   experienced users — the fastest path to uninstall.
2. **Measure growth.** The ledger is the evidence that a user's comprehension frontier
   is moving (rider → engineer).

## Contract (proposed)

```ts
interface CompetenceModel {
  /** Confidence (0..1) that the user understands a concept right now. */
  confidence(concept: string): number;

  /** Should a gate fire for these concepts, given the user's frontier? */
  shouldGate(concepts: string[]): boolean;

  /** Record the outcome of a predict-then-reveal interaction. */
  record(event: {
    concepts: string[];
    predictionCorrect: boolean | null; // null = observe mode, no prediction made
    at: number;                          // timestamp
  }): void;
}
```

## Start simple, keep it swappable

Ship a **naive local ledger** first: per-concept counts of predictions
right/wrong plus last-seen timestamps, with confidence decaying over
`decayHalfLifeDays`. It's stored at `competence.ledgerPath` and never leaves the
machine.

Keep the interface swappable so the model can evolve toward real **knowledge-tracing /
adaptive-difficulty** (Bayesian Knowledge Tracing, DKT, etc. — the same family of
techniques behind Duolingo and Khan Academy). That evolution is where the most
interesting research contributions live.

## Open questions

- Concept granularity: how coarse/fine is a "concept"? (Too fine = never confident; too
  coarse = gates the wrong things.)
- Decay: does understanding-once mean understanding-forever? Almost certainly not.
- Cold start: how does a brand-new user get a reasonable frontier without over-gating on
  day one?
