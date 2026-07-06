# Reckoner — Plain-English Reference

> A come-back-to-it explainer for how Reckoner works: what each piece does, how the
> pieces are wired, the protocols and concepts behind them, and why it's built this way.
> Style is deliberately plain, with analogies. For the *why* of the product see
> [`concept.md`](concept.md); for the settled build-shape decisions see
> [`architecture.md`](architecture.md). If this file and the code ever disagree, the code
> wins — and that's a docs-parity bug to fix.

---

## What Reckoner is (in one breath)

When an AI agent proposes to do something irreversible — force-push, drop a table, delete
a folder, deploy to prod — Reckoner steps in *just before you approve* and makes sure you
actually understand what you're about to greenlight. It does this by asking you to
**predict the consequence** before it reveals it.

**Mental model:** Reckoner is the **driving instructor with the passenger-side brake**, not
a **speed camera**. A camera fines you after the fact and teaches nothing. An instructor
sits beside you, and *at the moments that actually matter* asks "what happens if you take
this turn at this speed?" — and only taps the brake if you clearly don't know. The goal is
that you come out a better driver, not a more-supervised one. Tagline: *not for agents —
for humans.*

The failure it's fighting is the **agent-rider**: someone who rubber-stamps a black box
they don't understand. The win condition is the **engineer**: someone who still understands
the system the agent is building for them.

---

## The one big idea: predict-then-reveal 🎯

Everything hinges on one mechanic. When a gate fires, it does **not** just explain the risk
to you. People skim explanations exactly the way they skim diffs — eyes glaze, "yeah yeah,
approve." So Reckoner asks you to **commit to a prediction first**:

> *"Teammates have commits on this branch. After your force-push, what happens to their
> work?"*
> (a) Git merges them automatically (b) They're gone from the remote… (c) Git rejects it…
> (d) Nothing, commits are immutable…

You pick. *Then* it reveals the answer. The gap between your guess and reality is the whole
point — that surprise is what sticks, the same way a doctor asking "what do you think this
test will show?" makes you remember the result far better than being handed a printout.

**Real-life analogue:** this is the *testing effect* (a.k.a. retrieval practice) from
cognitive science — actively retrieving/committing to an answer produces far stronger
memory than passively re-reading. Flashcards beat highlighting for the same reason.

### Why multiple choice, not free text?

The prediction is a **selection** (pick a/b/c/d), graded by a plain string comparison — no
LLM, no tokens, one keypress of friction. That's a deliberate trade:

| | Selection (default) | Free-text + LLM grading (deep mode) |
|---|---|---|
| Teaches (commit-before-reveal)? | ✅ yes | ✅ yes, slightly more |
| Cost per gate | **zero tokens** | one LLM call |
| Friction | one keypress | type a sentence |
| Distractors as teaching | ✅ each wrong option is a real misconception | n/a |

The distractors are not filler — **each wrong answer encodes a misconception someone
actually holds** ("reflog has everything", ".gitignore protects tracked files"), and picking
it shows you *why* that belief is wrong. Free-text survives only as opt-in **deep mode**
(Tier 3), for learners or high-stakes moments.

---

## The tiered resolver: reach for the cheapest source first 🪜

The core engineering constraint (see `architecture.md`): **the default path must add ~zero
tokens and ~zero context to your session.** A comprehension tool that doubles your bill or
bloats the agent's context gets uninstalled — and an uninstalled tool teaches nobody.

So the intelligence is arranged as a **triage line**. Each tier is cheaper than the next,
and Reckoner only escalates when it must:

```
Tier 0  Deterministic detect   — free   — "does anything fire at all?"
Tier 1  Authored cards         — free   — pre-written predict-then-reveal, the primary bet
Tier 2  Spawned capsule (LLM)  — budget — novel actions no card covers yet
Tier 3  Deep mode (LLM)        — opt-in — free-text prediction + LLM grading
```

**Analogy:** it's medical triage. A nurse's reflex checks (pulse, temperature) are free and
catch most things → Tier 0. Pre-printed care sheets handle the common diagnoses → Tier 1.
Only the genuinely unusual case pages a specialist, who costs real money → Tier 2. And the
full work-up is reserved for when it's warranted → Tier 3.

### Tier 0 — deterministic detect ([`src/detectors/deterministic.ts`](../src/detectors/deterministic.ts))

A hand-written table of **boundary patterns**: `git push --force`, `DROP TABLE`, `rm -rf`,
editing a `.env`, `terraform apply`, `vercel --prod`, `npm publish`, and so on. Each pattern
is one or more **case-insensitive regexes** matched against just two things:

- `tool` — the tool identity (`bash`, `edit`, `write`, …)
- `args` — the coarse arguments as one flat string (a command line, a file path)

That's it. **No parsing of code structure**, ever. This is a load-bearing choice (principle
2, "concept-level not diff-level"): matching on tool + coarse args is what makes Reckoner
**language-agnostic** — it doesn't need a Python parser and a Go parser and a Rust parser; a
force-push looks the same in every repo. The cost is precision (a regex is blunter than an
AST), which is exactly why detection only keys on *irreversible moments*, where a blunt-but-
certain signal is fine.

"Silent by default" is therefore also "**free** by default": if Tier 0 matches nothing,
Reckoner spent zero tokens and says nothing. Plain `git push`, `rm foo.txt`, editing
`authors.ts` — all sail through untouched. (Verified: only the dangerous coarse patterns
trip it.)

### Tier 1 — authored cards ([`cards/`](../cards) + [`src/cards.ts`](../src/cards.ts))

A **card** is a pre-authored predict-then-reveal exchange for one recognized pattern. It's a
JSONC file carrying the mechanism, the consequence, and the selection block (question +
options + which is correct + each distractor's misconception). Cards are the **primary bet**:
*a card authored once is a gate that never costs a token again.* The product's quality lives
in card coverage and card quality — which is exactly where an open-source project wants it:
contributors write cards (data), not infrastructure (code). See
[`cards/CLAUDE.md`](../cards/CLAUDE.md) for the authoring guide.

Cards are validated by a **zod** schema at load time (`npm run check:cards`), and a broken
card is skipped with a warning rather than crashing the loader — one bad community card can't
take the whole gate offline.

### Tier 2 — spawned capsule ([`src/engine.ts`](../src/engine.ts))

When Tier 0 fires but no card covers the action, Reckoner can spawn a **subagent** with an
isolated context and a cheap model to generate a card-shaped **capsule** on the fly (same
shape: mechanism, consequence, selection). "Isolated context" matters: the capsule is
generated off to the side and only its result comes back, so it **doesn't pollute your main
agent's context window**. Rare by construction, because Tiers 0–1 already catch the recurring
cases.

### Tier 3 — deep mode

Opt-in luxury: free-text prediction graded by the LLM, for learners or high-stakes moments.
Never the default.

### The budget guard (why you can't get a surprise bill)

The rule is stronger than "try to be cheap": **it must be structurally impossible for
Reckoner to make an unbudgeted LLM call.** Concretely, in
[`src/resolver.ts`](../src/resolver.ts), when your profile forbids escalation the capsule
provider **is not even retained** — Tier 2 isn't "skipped by an if-statement," it's
unreachable because the object that could make the call doesn't exist. On top of that a
per-session **spawn cap** (`resolver.maxSpawnsPerSession` in the config — no longer a
hardcoded constant) bounds how many capsules can ever be generated; it's a **required**
input when the resolver is constructed, so there is no code path that spends without a
stated bound. And a failed capsule **downgrades** the gate to silent rather than blocking
or erroring. Belt, suspenders, and a second belt.

---

## Profiles: one knob that changes how intelligence is sourced 🎚️

`profile` in the config isn't just a threshold dial — it decides *how Reckoner spends*:

| | **Learner** | **Builder** (default) | **Expert** |
|---|---|---|---|
| Wants | to understand the system — learning *is* the product | confidence at the moments that matter | awareness without interruption |
| Resolver | cards first, escalates to capsules readily | cards first, capsule only for novel high-stakes | cards only, **never spends a token** |
| Gate posture | more categories, coaches, deeper reveals | gates at irreversible boundaries, quiet elsewhere | observes almost everywhere |
| Spend | accepted — that's the tuition | minimal, bounded | zero |

For the builder, Tier 0 keys on *irreversible* moments (push, migration, deploy, delete,
spend) — **not** per-edit, because edits are cheap to undo and pushes aren't. That keeps the
default profile near-silent and near-free.

---

## The gate loop: one auditable path from action to gate 🔁

The [`Orchestrator`](../src/orchestrator.ts) owns the single pipeline, and its ordering is
the mechanism that makes "silent by default" *auditable* — every place a gate can be dropped
is visible in sequence:

```
detect → config → competence → cap → content → run → record
```

1. **detect** (Tier 0, free) — get candidate triggers.
2. **config** — drop any category set to `off`.
3. **competence** — drop anything the competence model says is already below your frontier
   (see next section). This is the anti-patronizing filter.
4. **cap** — keep only the highest-stakes survivors, up to `maxPromptsPerAction`, so a single
   action can't bury you in prompts.
5. **content** — *only now*, for gates that will actually fire, resolve the card (or spend on
   a capsule). Ordering is deliberate: **content resolution comes last, so a gate that won't
   fire can never cost a token.** No content affordable → downgrade to silent observe.
6. **run** — for `observe`, just log; for `coach`/`gate`, do predict-then-reveal.
7. **record** — write the outcome to the competence ledger *and* append one line to
   the [interaction log](#the-interaction-log-a-local-trust-ledger-) (see below).

The four **modes** a category can resolve to, from quietest to loudest: `off` (nothing) →
`observe` (log only, never interrupts) → `coach` (teach, then allow) → `gate` (block until
you demonstrate understanding). When unsure, the project's bias is always toward the quieter
one — because of the **friction paradox**:

> A gate that fires when it isn't needed gets disabled — and a disabled gate is
> rubber-stamping *with extra steps*. So every gate has to earn its interruption.

**Real-life analogue:** the car alarm nobody responds to anymore. It "fires" so often on
nothing that it trained everyone to ignore it. Reckoner would rather stay silent and be
trusted than fire constantly and be muted.

---

## The competence ledger: the moat 🧠 ([`src/competence.ts`](../src/competence.ts))

This is the piece that keeps Reckoner from becoming annoying, and it's the hardest to copy.
It's a small **local** file (`.reckoner/competence.json`) that tracks, per concept, how many
times you've seen it and how often you predicted correctly, plus when you last saw it.

- Get a concept right and its **confidence** rises; cross a threshold (the "frontier") and
  Reckoner **stops gating you on it** — principle 4, *never gate below the user's frontier.*
  Gating an expert on something they demonstrably know is the fastest way to get uninstalled.
- Confidence **decays** over time (a configurable half-life), because knowledge you haven't
  touched in months isn't as sharp. This is literally the **spaced-repetition** curve from
  learning software like Anki.

**Analogy:** a good tutor stops quizzing you on your times tables once you've proven you know
them — but might spot-check again after a long summer off. The ledger is that tutor's memory.

**Privacy is non-negotiable:** the ledger is local and must *never* be committed or
transmitted (it's gitignored via `.reckoner/`). It's a model of *you*; it stays on your
machine. Keeping it swappable also lets it evolve toward real knowledge-tracing later without
touching the rest of the system.

---

## The interaction log: a local trust ledger 🧾 ([`src/interactions.ts`](../src/interactions.ts))

The ledger models *what you know*; the interaction log records *what actually happened at the
gate*. It's an **append-only JSONL** file (`.reckoner/interactions.jsonl`) — one line per gate
outcome — sitting right next to the ledger, and just as **local and gitignored**. Each line
carries: a timestamp, a **fingerprint** of the action, the category, the effective mode, the
tier that supplied the content, the card id, the prediction verdict, and whether the action
proceeded.

The word *fingerprint* is load-bearing: the log stores a one-way **hash of the tool + coarse
args**, never the raw command or file path. So you can answer "how often does the force-push
gate fire, and do I predict it right?" without the log ever holding a transcript of your
commands. It's the same privacy stance as the ledger — a measurement surface that reveals
*patterns*, not *content*.

Why it exists: Reckoner's whole thesis is that the gate should **earn its interruption**. You
can't judge that from vibes. The log is the evidence — later it can drive "this gate fires a
lot and you always nail it, want to silence it?" — and it's wired as a swappable sink (the
`InteractionLog` interface), so a test or a future adapter can substitute an in-memory or
no-op recorder without touching the gate loop. A fully silent action (no gate fired) writes
nothing; there's no outcome to record.

---

## How the pieces are wired 🔌

```
CLI adapter        Claude Code hook (prototype)      future adapters
      \                    |                            /
       ───────────── GateIO seam ──────────────────────
                (AgentAction in, decision out)
                           |
                     Orchestrator     ← detect→config→competence→cap→content
                    /      |      \
              Resolver  Competence  Config
              /   \          |         |
         detect  cards   .reckoner/  reckoner.jsonc
         (T0)    (T1)    (ledger +
                          interactions)
            \
          Engine (T2/T3, only reachable when the profile + budget allow)
```

- **`GateIO`** is the seam: a UI-agnostic interface (`announce`, `select`, `predict`,
  `reveal`, `requireUnderstanding`). The core doesn't know whether it's talking to a
  terminal, a Claude Code hook, or a future IDE — each adapter just implements `GateIO`.
  This is the classic **ports-and-adapters** (hexagonal) shape: one integration-agnostic
  core, many thin adapters.
- **`AgentAction`** is the concept-level description that flows in — intent, summary, plus
  the `tool`/`args` that Tier 0 matches on. Never a raw diff.
- **`src/cli.ts`** is the runnable test bench (`npm run demo`). The default path runs
  **fully offline** — no API key needed, because Tier 0 + Tier 1 + string-compare grading
  never call an LLM. A key only unlocks Tiers 2–3.

---

## Config: the behavior contract 📄 ([`config/reckoner.jsonc`](../config/reckoner.jsonc))

The config is "the product's soul" — it decides *when* a gate fires, *how hard*, *how deep*,
and *whether it teaches*. The shape is a matrix:

```
categories × { mode, depth, learningMode }
```

- **categories:** `blastRadius` (reversibility/scope), `security` (auth/secrets/exposure),
  `cost` (spend), `novelty` (new-to-you concepts), `architecture` (cross-cutting wiring).
- **mode:** `off` / `observe` / `coach` / `gate` (quietest → loudest).
- **depth:** `concept` / `consequence` / `wiring` — how deep the reveal goes.
- **learningMode:** `on` / `off` / `inherit` — whether it asks you to predict, or just
  explains.

Alongside the matrix, the **`resolver`** section governs the paid tiers: a
`maxSpawnsPerSession` cap and a per-profile `escalate`/`deepModeAllowed` policy. Tiers 0–1
are always free and untouched by it. Full field-by-field docs live in
[`config-schema.md`](config-schema.md).

It's authored as **JSONC** (JSON + comments) so the file can document itself; a small
comment-stripping loader ([`src/config.ts`](../src/config.ts)) feeds it to `JSON.parse`,
respecting string literals so a `//` inside a URL survives.

---

## Protocols, formats & stack at a glance

| Thing | What it is | Where it shows up |
|---|---|---|
| **TypeScript, ESM, strict** | typed JS, modern modules | the whole codebase; `npm run typecheck` gates it |
| **JSONC** | JSON with comments | config + cards (human-authored, self-documenting) |
| **zod** | runtime schema validation | card schema, and the engine's strict-JSON parsing |
| **Anthropic SDK** (`claude-opus-4-8`) | the LLM client | Tier 2/3 only, in `engine.ts` |
| **regex over tool+args** | coarse pattern match | Tier 0 detection — no AST, language-agnostic |
| **`PreToolUse` hook** (Phase 3) | Claude Code's pre-action interception point | where the real adapter will live |

**On the SDK note:** the engine prompts for strict JSON and validates it with zod, rather
than using the SDK's structured-output helper. That's a deliberate robustness choice — it
works across SDK versions and doesn't pin us to a helper that may not exist on the installed
version.

---

## Why it's built this way — the trade-offs, honestly

- **Coarse detection vs. AST parsing.** We give up precision (a regex can't tell a safe
  `DELETE` with a `WHERE` from a catastrophic one) to gain language-agnosticism and zero
  per-language maintenance. Mitigation: only gate irreversible *moments*, where "certain but
  blunt" is the right tool. Compare: a smoke detector doesn't identify *what's* burning; it
  just reliably catches the category "fire."
- **Cards (data) vs. always-LLM (code).** Authored cards cost human time up front but are
  free and instant forever, and their distractors teach precisely. An always-LLM design would
  be zero-authoring but cost tokens on every gate and vary in quality. We bet on cards and
  keep the LLM as the rare novelty escape hatch.
- **Selection vs. free-text.** We accept slightly-shallower prediction to get zero-cost,
  one-keypress friction and misconception-encoding distractors. Free-text is there when you
  opt into paying for it.
- **Local competence ledger vs. cloud profile.** Local means privacy and no infra, at the
  cost of not syncing across machines. For a tool whose entire pitch is "we model *you*,"
  keeping that model on your machine is the trust-preserving choice.

---

## Where things live (quick map)

| Path | Role |
|---|---|
| [`config/reckoner.jsonc`](../config/reckoner.jsonc) | the behavior contract (categories × mode × depth) |
| [`cards/`](../cards) | authored comprehension cards (Tier 1) + authoring guide |
| [`src/detectors/deterministic.ts`](../src/detectors/deterministic.ts) | Tier-0 boundary patterns |
| [`src/cards.ts`](../src/cards.ts) | card schema (zod) + JSONC loader |
| [`src/resolver.ts`](../src/resolver.ts) | the tiered resolver + profile policy + budget guard |
| [`src/orchestrator.ts`](../src/orchestrator.ts) | the gate loop (detect→…→record) |
| [`src/competence.ts`](../src/competence.ts) | the local competence ledger (the moat) |
| [`src/interactions.ts`](../src/interactions.ts) | the append-only local interaction log |
| [`src/engine.ts`](../src/engine.ts) | Claude-backed Tier-2/3 provider |
| [`src/config.ts`](../src/config.ts) | JSONC config loader |
| [`src/cli.ts`](../src/cli.ts) | runnable test bench (`npm run demo`) |
| [`integrations/claude-code/`](../integrations/claude-code) | the `PreToolUse` hook adapter (prototype — see its README for the deny-relay protocol) |

## Commands I'll need

```bash
npm run typecheck                          # tsc --noEmit — the gate before any push
npm run check:cards                        # validate every card in cards/ (offline)
npm run demo                               # the gate loop on a sample force-push (offline)
npm run demo -- git push --force origin x  # feel the gate on any command
npm run demo -- --deep <command>           # Tier-3 deep mode (needs ANTHROPIC_API_KEY)
rm -rf .reckoner                           # reset the local ledger + interaction log while testing
```
