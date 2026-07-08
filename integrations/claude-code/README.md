# Claude Code integration — the PreToolUse hook (prototype)

Reckoner's first real adapter. [`hook.ts`](hook.ts) runs as a **`PreToolUse` hook**:
Claude Code invokes it before every matching tool call, which is exactly the
interception point a comprehension gate needs — it fires on the *event*, not on
anyone remembering to invoke it. (That's also why this is a hook and not a skill:
a skill is invoked at the model's discretion, and a guardrail the agent can forget
to run isn't a guardrail.)

## Install (into any project)

Add to the target project's `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            // Point at hook.ts inside your Reckoner checkout. tsx must be
            // resolvable (it is, when the project sits inside or beside the
            // Reckoner repo; otherwise use an absolute npx path).
            "command": "npx tsx \"/path/to/Reckoner/integrations/claude-code/hook.ts\"",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

State (competence ledger, interaction log, pending-gate files) lives in the
**hooked project's** `.reckoner/` — per-project, local, never committed. Cards and
config load from the Reckoner repo. Reset while experimenting: `rm -rf .reckoner`.

## How the gate reaches you: the deny-relay protocol

The design constraint (verified against the hooks docs, v2.1.139+): **hook
processes have no controlling terminal.** No `/dev/tty`, no direct prompts. The
predict-then-reveal exchange therefore runs as a state machine *across* hook
invocations, relayed through the agent:

```
you: "force-push this"
  └ agent runs Bash(git push --force …)
      └ hook: Tier-0 detect → card → save pending gate → DENY
        reason (seen by agent): the framed question + relay protocol
  └ agent presents the question to YOU via AskUserQuestion, verbatim
  └ you pick (a)/(b)/(c)/(d)
  └ agent writes the letter to .reckoner/gate.answer   ← hook auto-allows this
  └ agent re-runs the original command
      └ hook: grade (string compare, zero LLM) → record ledger + log
          correct        → let through* + reveal as a systemMessage
          wrong (coach)  → let through* + teach (misconception + reality)
          wrong (gate)   → DENY again with the reveal; you must explicitly
                           accept the quoted consequence (.reckoner/gate.ack)
                           before a re-run opens the gate
```

**Round 0 (novelty, Tier 2).** If a boundary fires but *no card covers it*, the hook
generates a card-shaped capsule out-of-band before round 1 — the hook process can't
call the model or spawn, so it relays a subagent spawn the same way it relays the
question:

```
  └ agent runs Bash(<novel boundary, no card>)
      └ hook: cache miss + budget left → save request → DENY
        reason (seen by agent): spawn a subagent with THIS capsule prompt,
        write its JSON to .reckoner/gate.capsule.json, re-run   ← write auto-allowed
  └ agent spawns a cheap subagent → writes the capsule JSON → re-runs
      └ hook: validate vs the shared CapsuleSchema → cache under the action
        fingerprint → charge the persisted per-session spawn budget → round 1
```

The capsule is cached at `.reckoner/capsules/<fingerprint>.json` (cross-session — the
same novelty is never paid for twice) and the spawn budget lives in
`.reckoner/spawns.json` keyed by `session_id` (on disk because each hook invocation is
a fresh process — an in-memory cap would reset every round). Over budget → silent
observe, no spawn. A malformed capsule fails open (the action proceeds ungated, once).

**The envelope carries protocol state only — never risk content.** Agents
narrate deny reasons to the user, so a risk summary in the deny header arrives
as an explanation *before* the question — inverting predict-then-reveal (third
dogfood finding: the Tier-0 trigger reason for `rm -rf` was nearly verbatim the
correct answer). Risk content exists in exactly two places: the question
(before the answer) and the reveal (after). The deny also instructs the agent
to say nothing about *why* the action was held beyond "Reckoner is holding
this action behind a prediction check."

**The pending gate survives interleaved actions.** Agents routinely run reads
and checks (`ls`, `git status`, …) between relaying the question and re-running
the gated command. Those unrelated calls pass through without touching the
saved exchange — only expiry (15 min) or a *new* gate firing replaces it.
(Second dogfood finding: clearing state on any non-matching action re-opened
the gate on every re-run — the agent asked the same question in a loop.)

**The frame travels inside the payload.** First dogfood finding: a bare
question relayed through AskUserQuestion reads as the *agent* asking your
preference ("where should this be backed up?"), not as a prediction with a
right answer — which kills the predict-then-reveal mechanic. So the verbatim
text itself now opens with "Reckoner prediction check — exactly one option is
correct; the answer is revealed after you commit" plus what a wrong answer
costs in the current mode (gate: blocked-until-accept; coach: proceeds either
way). Same rule at the ack step: the consequence being accepted is quoted
inside the question, so accepting means having just read it. Anything said
only to the agent never reaches you — the relay strips all surrounding
context.

\* "Let through" = **defer**, not allow: the action falls back into Claude Code's
normal permission flow, so your own permission settings still apply. Reckoner
gates *comprehension on top of* permission; it never lowers permission. The only
`allow` the hook ever emits is for its own one-letter relay writes.

The default path (round 1) is Tier 0/1 (deterministic detect + authored cards):
**zero tokens, no API key**. Tier 2 (round 0, above) is reached only for a boundary
no card covers, and even then the spend is a relayed subagent on your own session
budget — the hook process itself never calls the model.

## Honest limitations (prototype)

- **The agent relays the question.** A misbehaving agent could answer itself
  instead of asking you; the transcript makes that auditable, but the seam is
  real. Closing it needs a harness-level ask mechanism.
- **The understanding-ack is a confirmation, not a check.** Like the CLI's
  restate step, it proves intent, not comprehension.
- **Latency:** each matched tool call pays an `npx tsx` startup (~0.5s).
  Compiling the hook to a single JS file would remove most of that.

## Test bench vs. real feel

`npm run demo -- <command>` (repo root) remains the fastest way to feel and tune
cards. This hook is where you feel the gate **in the real agent flow** — set up a
throwaway project with the settings above and ask Claude to do something risky.
