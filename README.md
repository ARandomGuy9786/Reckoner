# Reckoner

> **Guardrails for agents are everywhere. There are none for the human.**
>
> _Not for agents — for humans._

Reckoner is a comprehension layer that sits between an AI agent's proposal and your
approval. Before you accept a consequential action, it makes sure you actually
understand **what you asked for, how it will be wired, and what it will do** — so you
stay the engineer instead of becoming an *agent-rider*.

The name is a nudge: to _reckon_ is to work something out and judge its consequences.
A reckoner is the person who does that — instead of skimming the diff and clicking
approve.

---

## The problem

We've spent enormous effort building guardrails **for the agent**: permissions, rules,
constraints on what it's allowed to do. But there's no equivalent guardrail **for the
human**. The failure mode is quiet and common:

- You glance at a proposed change.
- You approve it without really grasping the mechanism or the blast radius.
- Repeat a few hundred times.

Over time this turns a builder into a **rider** — someone steering a system they can no
longer reason about. When natural language becomes the programming language, the risk
isn't that you can't read the code; it's that you stop understanding the **concepts,
protocols, and wiring** underneath what you're shipping.

Reckoner is designed to reverse that drift — and, in learning mode, to turn
building-with-an-agent into an actual way to _learn_ the system you're building.

## How it works

Reckoner operates at two altitudes. Keep them separate — they have different jobs.

### 1. The gate (micro — per action)
At the moment of a consequential decision, Reckoner intercepts and runs one loop:

```
detect  →  predict  →  reveal  →  branch
```

- **detect** — classify the action into a trigger category (blast radius, security,
  cost, novelty, architecture).
- **predict** — before telling you anything, ask you to _predict_ the consequence.
  ("What happens to existing sessions if we change this auth flow? What could break?")
- **reveal** — show the real intent → mechanism → consequence. The gap between your
  prediction and reality is the learning moment.
- **branch** — depending on your config: coach you and let you proceed, block until you
  demonstrate understanding, or silently log the comprehension gap.

**Predict-then-reveal is the core mechanic.** Just showing more explanation fails —
people skim explanations exactly like they skim diffs. Being asked to guess *first* is
low-friction and ungameable, because you have to actually think.

### 2. The map (macro — on demand)
A queryable view of the whole project: how the pieces are wired, which protocols and
tools are in play, and the programming concepts underneath. This is never a gate —
it's a living model of the system you can ask about any time.

## Design principle: concept-level, not diff-level

Reckoner is deliberately **not** a "read your code" tool. The subject is the reasoning
chain — **intent → mechanism → consequence** — with code as optional evidence. This
makes it language-agnostic, agent-native, and honest about how people actually work
with agents today: at the level of functionality and consequence, not line-by-line.

## It's yours to tune

Friction is the whole risk. A gate that fires when it isn't needed gets disabled — and
then you're back to rubber-stamping with extra steps. So Reckoner **stays silent by
default** and fires only where it earns its keep, driven by two things:

1. **Your config** — see [`config/reckoner.jsonc`](config/reckoner.jsonc) and the
   [schema contract](docs/config-schema.md). You choose which categories can fire, how
   hard they gate, how deep the explanation goes, and whether learning mode is on.
2. **A competence model** — an evolving, local model of what _you_ already understand,
   so you're never gated below your own frontier. A senior dev and a first-week learner
   run the same engine with completely different personalities.

Three presets ship out of the box — `learner`, `builder`, `expert` — and you can go
fully custom.

## Project status

Early scaffold. This commit establishes the **spine** (config schema + module
skeleton) and the **soul** (this README). See [`docs/concept.md`](docs/concept.md) for
the full design, including how each known failure mode maps to a design commitment.

## Contributing

Reckoner is built around three pluggable extension points — the obvious places to add
value:

- **[Detectors](src/detectors/)** — classify an incoming action into trigger categories.
- **[Explainers](src/explainers/)** — produce the intent → mechanism → consequence
  articulation for a category.
- **[Competence model](src/competence/)** — model what the user understands; start
  simple, evolve toward real knowledge-tracing.

See each directory's README for the interface. Issues and discussion welcome.

## License

MIT — see [LICENSE](LICENSE).
