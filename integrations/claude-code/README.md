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
        reason (seen by agent): the selection question + relay protocol
  └ agent presents the question to YOU via AskUserQuestion, verbatim
  └ you pick (a)/(b)/(c)/(d)
  └ agent writes the letter to .reckoner/gate.answer   ← hook auto-allows this
  └ agent re-runs the original command
      └ hook: grade (string compare, zero LLM) → record ledger + log
          correct        → let through* + reveal as a systemMessage
          wrong (coach)  → let through* + teach (misconception + reality)
          wrong (gate)   → DENY again with the reveal; you must explicitly
                           confirm understanding (.reckoner/gate.ack) before
                           a re-run opens the gate
```

\* "Let through" = **defer**, not allow: the action falls back into Claude Code's
normal permission flow, so your own permission settings still apply. Reckoner
gates *comprehension on top of* permission; it never lowers permission. The only
`allow` the hook ever emits is for its own one-letter relay writes.

Everything on this path is Tier 0/1 (deterministic detect + authored cards):
**zero tokens, no API key**. There is no capsule provider in the hook yet — the
Tier-2 spawn protocol from hook context is still an open design flag.

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
