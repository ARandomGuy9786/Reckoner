#!/usr/bin/env bash
# Reckoner guardrail — tests-before-push + docs-parity nudge.
#
# Wired as a PreToolUse(Bash) hook in .claude/settings.json. It inspects the
# command Claude is about to run; if it's a `git push`, it enforces the
# project's pre-push gate (typecheck + card validation) and blocks the push
# when either fails. Everything that isn't a push passes straight through —
# silent by default, the same principle the product itself is built on.
#
# Contract (Claude Code hooks):
#   stdin  = JSON  { "tool_input": { "command": "..." }, ... }
#   exit 0 = allow the tool call
#   exit 2 = block it; stderr is fed back to Claude as the reason
#
# The gate fails OPEN (exit 0) on any environment problem — a missing
# interpreter must never wedge your workflow. The documented working
# agreement in CLAUDE.md is the backstop.

set -uo pipefail

input="$(cat)"

# Pull the command out of the JSON with python3 (robust against quoting/escapes);
# if that fails for any reason, treat it as "not a push" and allow.
cmd="$(printf '%s' "$input" | python3 -c \
  'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' \
  2>/dev/null)" || exit 0

# Only gate real pushes. `git push`, `git  push`, `&& git push …` all match;
# things like `git push-notification-tool` or a commit message mentioning push
# do not (word boundary after "push").
printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]-])git[[:space:]]+push([[:space:]]|$)' || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

if ! out="$(npm run --silent typecheck 2>&1)"; then
  {
    echo "🚫 Push blocked — tests-before-push guardrail: typecheck failed."
    echo "Fix the type errors, then push again."
    echo "----- tsc output -----"
    echo "$out"
  } >&2
  exit 2
fi

if ! out="$(npm run --silent check:cards 2>&1)"; then
  {
    echo "🚫 Push blocked — tests-before-push guardrail: card validation failed."
    echo "Fix the offending card(s), then push again."
    echo "----- check:cards output -----"
    echo "$out"
  } >&2
  exit 2
fi

# Gate passed. Surface the docs-parity reminder at the push boundary — this is
# the "end of a major upgrade" moment where docs are most likely to have drifted.
echo "✓ typecheck + cards green. Docs-parity: confirm CLAUDE.md, docs/, and local/handoffs reflect this change before it lands." >&2
exit 0
