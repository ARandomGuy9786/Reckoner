# Contributing to Reckoner

Thanks for wanting to help keep humans in the engineer's seat.

Reckoner is early — the scaffold defines a clear shape, and the most valuable
contributions right now are at the three extension points and in pressure-testing the
concept. Please read [`docs/concept.md`](docs/concept.md) first; it explains *why* the
design is the way it is, so contributions can stay aligned with the thesis.

## The one rule that governs everything

**Silent by default.** Reckoner's biggest risk is the *friction paradox*: a gate that
fires when it isn't needed gets disabled, and then we've rebuilt rubber-stamping with
extra steps. Any change that makes gates fire more often, or harder, must justify itself
against that risk. When in doubt, prefer `observe` over `coach`, and `coach` over `gate`.

## Where to contribute

Three pluggable extension points, each with a proposed interface in its README:

- **[Detectors](src/detectors/)** — classify a proposed action into trigger categories.
  Good first PRs: detectors for specific tools/protocols; better `concepts[]` extraction.
- **[Explainers](src/explainers/)** — produce the intent → mechanism → consequence
  reveal. Good first PRs: sharp `predictPrompt`s (a prompt you can be *wrong* about),
  depth-aware templates.
- **[Competence model](src/competence/)** — model what the user understands. Good first
  PRs: a naive local ledger; later, real knowledge-tracing.

The **[orchestrator](src/orchestrator/)** owns the resolution order that enforces
"silent by default." Changes there need extra care and a clear rationale.

## Design principles (don't drift from these)

1. **Concept-level, not diff-level.** The subject is intent → mechanism → consequence,
   with code as optional evidence. No per-language AST parsing.
2. **Predict-then-reveal, not more explanation.** People skim explanations like diffs.
3. **Never gate below the user's frontier.** The competence model modulates everything.
4. **Two altitudes stay separate.** The gate (micro) and the map (macro) are different UX.

## Workflow

1. Open an issue first for anything non-trivial — a
   [concept discussion](.github/ISSUE_TEMPLATE/concept-discussion.md) or a
   [feature/change](.github/ISSUE_TEMPLATE/feature.md) — so we can agree on shape before
   code exists.
2. Fork, branch (`feat/…`, `fix/…`, `docs/…`), and keep PRs focused.
3. In the PR description, name the failure mode your change addresses or the extension
   point it touches, and how it respects "silent by default."
4. Be kind. This project is partly about helping people *understand* — that ethos
   applies to reviews too.

## Not sure where to start?

Open a [concept discussion](.github/ISSUE_TEMPLATE/concept-discussion.md). The open
questions at the bottom of `docs/concept.md` (comprehension scoring, competence decay,
concept granularity, cold start) are all live and worth arguing about.

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
