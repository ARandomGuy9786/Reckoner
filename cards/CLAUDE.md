# CLAUDE.md — cards/

Authoring guide for comprehension cards. This directory is a delegation target:
everything a card author needs is in this file plus `src/cards.ts` (the schema).

## What a card is

A card is a pre-authored predict-then-reveal exchange for one recognizable boundary
pattern (force-push, destructive migration, …). Cards are **Tier 1** of the resolver:
they cost zero tokens at runtime, forever. Card coverage and card quality are where
this project's value lives.

## Format

One JSONC file per card, filename = card `id`. Validated against the zod schema in
`src/cards.ts` — run `npm run check:cards` after any change; it must exit clean.

```jsonc
{
  "id": "git-force-push",            // kebab-case, matches filename
  "title": "Force-push over remote history",
  "pattern": "git-force-push",       // key to a built-in boundary pattern id
                                     // (src/detectors/deterministic.ts), OR:
  // "match": [{ "tool": "bash", "args": "regex over coarse args" }],
  "category": "blastRadius",         // blastRadius | security | cost | novelty | architecture
  "concepts": ["git-history-rewrite"], // feeds the competence model
  "mechanism": "How it works — the concept, not the code.",
  "consequence": "What actually happens, incl. what cannot be undone.",
  "selection": {
    "question": "One sharp question the user answers BEFORE the reveal.",
    "options": [ /* 2–5, exactly one with "correct": true */ ]
  }
}
```

Use `pattern` when a built-in boundary pattern already detects the moment; use your
own `match` clauses only for patterns the table doesn't know. Match clauses are
case-insensitive regexes over **tool identity + coarse args** (a command line, a file
path). Never match parsed code structure — that's the wrong altitude (CLAUDE.md
principle 2).

## The pedagogy (this is the hard part)

- **The question is a prediction, not a quiz.** Ask what will *happen* — something a
  reasonable person could get wrong — never "what does this command do?".
- **Distractors are the teaching instrument.** Each wrong option encodes one *real*
  misconception — something people actually believe ("reflog has everything",
  ".gitignore protects tracked files"). Its `misconception` field explains why people
  believe it and why it's wrong; that text is shown when the option is picked.
  Every distractor should have one.
- **Exactly one correct option**, and it should be honest — include the caveats
  ("only in clones that already fetched", "recoverable via forensic fsck").
- **Vary the position of the correct option across cards.** Options render in
  authored order; don't let "b" always be right.
- **mechanism/consequence carry the reveal.** Concept-level, 1–3 sentences each,
  no code snippets. The consequence must name what is irreversible and why.

## Judging a card

A good card makes an experienced engineer say "yes, that's the actual footgun" and
makes a newcomer wrong in an *instructive* way. If a distractor is obviously silly,
it teaches nothing — replace it with a belief someone smart actually holds.
