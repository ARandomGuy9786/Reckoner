# Claude Code integration (prototype target)

The first planned home for Reckoner. Claude Code's **`PreToolUse` hook** fires right
before a consequential tool action runs — which is *exactly* the interception point the
gate needs. That makes it the cheapest way to validate the riskiest assumption: **is the
friction tolerable, and does predict-then-reveal actually improve comprehension?**

## Plan

- A `PreToolUse` hook receives the proposed action, hands it to the orchestrator, and:
  - lets it through (`observe` / passed gate),
  - or holds it and surfaces the predict → reveal exchange (`coach` / `gate`).
- A companion **skill** exposes the macro "map" view ("explain the system") on demand.

## Why start here (and not standalone)

A standalone cross-IDE product is the eventual vision, but building it before the core
loop is proven non-annoying is premature. The hook gives us the full loop
(detect → predict → reveal → branch) with almost no infrastructure. Prove it here, then
generalize.

Status: not yet implemented — this is commit-#2 territory (the "feel the friction"
prototype). Scaffold only for now.
