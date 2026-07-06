# Config schema (the contract)

Reckoner's behavior is data, not code. This file documents every field so users and
contributors read from the same source of truth. The machine-checkable version lives in
[`config/reckoner.schema.json`](../config/reckoner.schema.json); a worked example is
[`config/reckoner.jsonc`](../config/reckoner.jsonc).

Guiding rule: **silent by default.** A gate fires only where the config says it may
*and* the competence model says it's worth it.

## Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | `2` | — | Config schema version. |
| `profile` | `learner \| builder \| expert \| custom` | `builder` | Preset that seeds `categories`, and selects a `resolver.profiles` policy. Explicit fields always win. |
| `learningMode` | boolean | `true` | Global predict-then-reveal switch. Categories can override via `inherit`. |
| `competence` | object | see below | The user-competence model settings. |
| `resolver` | object | see below | How intelligence is sourced and spent — the budget guard. |
| `categories` | object | see below | The gate matrix — the heart of the config. |
| `gate` | object | see below | Global gate limits. |

## `competence`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turn the competence model on/off. |
| `ledgerPath` | string | `.reckoner/competence.json` | Local ledger of concepts seen + predictions. Never leaves the machine. |
| `skipBelowFrontier` | boolean | `true` | Skip a gate when a concept is confidently below the user's frontier. The main anti-patronizing defense. |
| `decayHalfLifeDays` | number \| null | `90` | How fast "known" confidence decays. `null` = never. |

## `resolver`

Governs how the tiered Resolver sources and spends intelligence. **Tiers 0–1
(deterministic detect + authored cards) are always free and are not affected by
anything here** — this section only decides whether the paid tiers are reachable.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxSpawnsPerSession` | integer | `2` | The budget guard's hard bound: how many Tier-2 subagent capsules a session may spawn. Tiers 0–1 don't count. `0` disables Tier 2 outright. When the cap is hit, further novel gates downgrade to `observe` rather than spending more. |
| `profiles` | object | see below | Per-profile escalation policy; the active `profile` selects one. |

Each entry in `profiles` is a `{ escalate, deepModeAllowed }` policy:

| `escalate` | When Tier 2 may run |
|---|---|
| `always` | Cards first, but escalate readily on a miss (learner — spend is the tuition). |
| `gate-only` | Escalate only for a novel action at a hard `gate` (builder — rare, bounded). |
| `never` | Cards only; the Tier-2 provider is **never even retained**, so a spawn is structurally impossible (expert — zero tokens). |

`deepModeAllowed` (boolean) decides whether Tier-3 free-text + LLM grading may be
turned on for that profile at all.

**Shipped defaults** (data, not code — retune freely):

| Profile | `escalate` | `deepModeAllowed` |
|---|---|---|
| `learner` | `always` | `true` |
| `builder` | `gate-only` | `true` |
| `expert` | `never` | `false` |

This is the "Profiles drive the resolver" table from
[`architecture.md`](architecture.md) made into config. The budget guard is
structural, not advisory: `never` drops the provider reference, and the cap is a
required construction input to the resolver — there is no code path that spends
without a stated bound.

## `categories`

Each of the five categories resolves to `{ mode, depth, learningMode }`.

**Categories** (what kind of action can fire a gate):

- `blastRadius` — reversibility / scope of damage (deletes, migrations, force-push, infra teardown)
- `security` — auth, secrets, permissions, network exposure
- `cost` — paid APIs, provisioning, spending money
- `novelty` — concepts/protocols/tools new **to this user** (competence-driven)
- `architecture` — cross-cutting changes; how things are wired

**`mode`** — what the gate does:

| Value | Interrupts? | Lets you proceed? | Use for |
|---|---|---|---|
| `off` | no | — | Categories you never want touched. |
| `observe` | no | yes (silent) | Pure signal: log whether you *could* have explained it. |
| `coach` | yes | yes, always | Friction with an escape hatch — teach, then allow. |
| `gate` | yes | only once understood | High-stakes: block until you demonstrate understanding. |

**`depth`** — how much the reveal shows: `concept` → `consequence` → `wiring`
(each includes the prior).

**`learningMode`** — `on` / `off` / `inherit`. `inherit` uses the global switch.
`on` = predict-then-reveal; `off` = plain explanation.

## `gate`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxPromptsPerAction` | integer | `1` | Caps predict prompts per action, to bound friction. |

## Presets (starting points)

Presets just seed the matrix; users tune from there.

| Category | `learner` | `builder` | `expert` |
|---|---|---|---|
| blastRadius | gate / wiring | gate / consequence | coach / concept |
| security | gate / wiring | gate / wiring | coach / consequence |
| cost | coach / wiring | coach / consequence | observe / concept |
| novelty | gate / wiring | coach / wiring | observe / concept |
| architecture | gate / wiring | coach / wiring | observe / consequence |
| learningMode | on | on | off |

The `expert` column is deliberately quiet: mostly `observe`, shallow depth, learning off
— because the fastest way to get uninstalled is to gate someone below their level.
