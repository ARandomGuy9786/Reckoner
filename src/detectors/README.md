# Detectors

A **detector** classifies an incoming agent action into zero or more trigger
categories. Detectors decide *whether a gate is even a candidate* — they run before the
config and competence model get a say.

## Contract (proposed)

```ts
interface DetectedTrigger {
  category: "blastRadius" | "security" | "cost" | "novelty" | "architecture";
  confidence: number;        // 0..1
  reason: string;            // human-readable why, shown in the reveal
  concepts?: string[];       // concepts this action touches (feeds the competence model)
}

interface Detector {
  name: string;
  /** Inspect a proposed action and return any triggers it matches. */
  detect(action: AgentAction): DetectedTrigger[] | Promise<DetectedTrigger[]>;
}
```

`AgentAction` is the concept-level description of what the agent intends — **not** a raw
diff. Detectors reason about intent and mechanism (e.g. "this runs a destructive DB
migration", "this exposes a new network port"), which keeps Reckoner language-agnostic.

## Good first contributions

- Detectors for specific tools/protocols (e.g. recognizing an auth-flow change, a
  package install, an infra provisioning call).
- Improving `concepts[]` extraction so the competence model learns faster.

Keep detectors cheap and side-effect-free. When in doubt, emit a low-confidence trigger
and let config/competence filter it out.
