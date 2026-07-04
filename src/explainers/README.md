# Explainers

An **explainer** turns a triggered action into the reveal: the
**intent → mechanism → consequence** chain, rendered at the configured `depth`.

## Contract (proposed)

```ts
interface Explanation {
  intent: string;        // what the human asked for, restated plainly
  mechanism: string;     // how it will be wired — protocols, tools, concepts
  consequence: string;   // what changes, what could break, what it costs
  predictPrompt: string; // the question asked BEFORE reveal (predict-then-reveal)
  concepts: string[];    // concepts covered, for the competence ledger
}

interface Explainer {
  category: TriggerCategory;
  /** Produce the reveal for a triggered action at the requested depth. */
  explain(action: AgentAction, depth: "concept" | "consequence" | "wiring"): Promise<Explanation>;
}
```

## Notes

- The `predictPrompt` is first-class, not an afterthought. A good prompt asks the user
  to predict a *consequence they can be wrong about* — that gap is the learning moment.
  Weak prompt: "what does this do?" Strong prompt: "what happens to existing sessions
  when this auth change ships?"
- `depth` is additive: `consequence` includes `concept`; `wiring` includes both.
- Explainers should read as concept-level prose, not code walkthroughs — Reckoner is
  for people who reason about functionality and consequence, not line-by-line.

## Good first contributions

- Category-specific explainers with sharp `predictPrompt`s.
- Depth-aware templates so `concept` stays short and `wiring` goes deep without rambling.
