import type { CategoryConfig, ReckonerConfig } from "./config.js";
import { learningActive } from "./config.js";
import type { Competence } from "./competence.js";
import type { InteractionEntry, InteractionLog } from "./interactions.js";
import { fingerprint } from "./interactions.js";
import type { Candidate, Resolution, Resolver } from "./resolver.js";
import type {
  AgentAction,
  Category,
  Explanation,
  Judgement,
  Mode,
  SelectionOption,
} from "./types.js";

// The orchestrator wires the gate loop (detect -> predict -> reveal -> branch)
// and owns the resolution order that keeps Reckoner silent by default. There is
// exactly one path from an action to a gate, and every drop point is visible in
// sequence. Content resolution (which may spend, at Tier 2) happens only AFTER
// config, competence, and the cap have had their say — a gate that won't fire
// can never cost a token. See src/orchestrator/README.md.

/** A candidate that survived config + competence filtering and will run. */
export interface ResolvedGate {
  candidate: Candidate;
  config: CategoryConfig;
  /**
   * What actually runs: `observe` either as configured, or as the downgrade
   * when no content was affordable for a coach/gate candidate.
   */
  effectiveMode: Mode;
  learning: boolean;
  /** Content for coach/gate; null for observe. */
  resolution: Resolution | null;
}

/** Grades free-text predictions — Tier-3 deep mode only. */
export interface DeepGrader {
  judge(explanation: Explanation, prediction: string): Promise<Judgement>;
}

/** UI-agnostic interaction surface. The CLI supplies the real implementation. */
export interface GateIO {
  /** Announce that a gate is firing. */
  announce(gate: ResolvedGate): void | Promise<void>;
  /** Selection prediction: show options, return the chosen index. */
  select(question: string, options: SelectionOption[]): Promise<number>;
  /** Free-text prediction (deep mode): return the user's answer. */
  predict(prompt: string): Promise<string>;
  /** Show the reveal at the configured depth. */
  reveal(explanation: Explanation, judgement: Judgement | null): void | Promise<void>;
  /**
   * For `gate` mode after a non-correct prediction: block until the user
   * demonstrates understanding. Return true to proceed, false to abort.
   */
  requireUnderstanding(): Promise<boolean>;
}

export type GateOutcome =
  | { kind: "observed"; gate: ResolvedGate }
  | {
      kind: "resolved";
      gate: ResolvedGate;
      judgement: Judgement | null;
      proceeded: boolean;
    };

export interface OrchestratorOptions {
  /** Tier-3 deep mode: free-text predictions graded by `grader`. Opt-in. */
  deepMode?: boolean;
  grader?: DeepGrader;
  /** Local append-only log of gate outcomes. Absent = don't record. */
  log?: InteractionLog;
}

const MODE_RANK: Record<Mode, number> = { gate: 3, coach: 2, observe: 1, off: 0 };

export class Orchestrator {
  constructor(
    private cfg: ReckonerConfig,
    private resolver: Resolver,
    private competence: Competence,
    private opts: OrchestratorOptions = {},
  ) {}

  /** Run the full loop for a proposed action. Returns per-gate outcomes. */
  async run(action: AgentAction, io: GateIO): Promise<GateOutcome[]> {
    const gates = await this.resolve(action);
    const outcomes: GateOutcome[] = [];
    const fp = fingerprint(action);
    for (const gate of gates) {
      const outcome = await this.runGate(gate, io);
      outcomes.push(outcome);
      // One append-only line per outcome — the trust ledger. Fingerprint only,
      // never the raw action. Silent (no-gate) actions produce no outcome and
      // are therefore not logged.
      this.opts.log?.append(toEntry(fp, outcome));
    }
    return outcomes;
  }

  /** detect -> config -> competence -> cap -> content. Silent by default. */
  async resolve(action: AgentAction): Promise<ResolvedGate[]> {
    const candidates = this.resolver.detect(action); // Tier 0: free

    const surviving: Array<{ candidate: Candidate; config: CategoryConfig }> = [];
    for (const candidate of candidates) {
      const config = this.cfg.categories[candidate.trigger.category];
      if (config.mode === "off") continue; // drop: category disabled
      if (
        (config.mode === "coach" || config.mode === "gate") &&
        !this.competence.shouldGate(candidate.trigger.concepts)
      ) {
        continue; // drop: below the user's frontier (anti-patronizing)
      }
      surviving.push({ candidate, config });
    }

    // Highest stakes first, then walk with the cap. Content (which may spend,
    // at Tier 2) is resolved only for candidates the cap admits.
    surviving.sort(
      (a, b) =>
        MODE_RANK[b.config.mode] - MODE_RANK[a.config.mode] ||
        b.candidate.trigger.confidence - a.candidate.trigger.confidence,
    );
    const cap = this.cfg.gate.maxPromptsPerAction;
    const gates: ResolvedGate[] = [];
    let prompts = 0;
    for (const { candidate, config } of surviving) {
      const category = candidate.trigger.category as Category;
      if (config.mode === "observe") {
        // `observe` never prompts, so it doesn't count against the cap.
        gates.push({
          candidate,
          config,
          effectiveMode: "observe",
          learning: false,
          resolution: null,
        });
        continue;
      }
      if (prompts >= cap) continue; // drop: friction bound

      const resolution = await this.resolver.content(
        action,
        candidate,
        config.mode,
        config.depth,
      );
      if (!resolution) {
        // No card, no affordable capsule: downgrade to observe rather than
        // firing an empty gate. Doesn't consume the cap.
        gates.push({
          candidate,
          config,
          effectiveMode: "observe",
          learning: false,
          resolution: null,
        });
        continue;
      }
      prompts += 1;
      gates.push({
        candidate,
        config,
        effectiveMode: config.mode,
        learning: learningActive(this.cfg, category),
        resolution,
      });
    }
    return gates;
  }

  private async runGate(gate: ResolvedGate, io: GateIO): Promise<GateOutcome> {
    await io.announce(gate);

    if (gate.effectiveMode === "observe" || !gate.resolution) {
      // Log only; never interrupt. Records the concepts as "seen".
      this.competence.record(gate.candidate.trigger.concepts, null);
      return { kind: "observed", gate };
    }

    const explanation = gate.resolution.explanation;
    let judgement: Judgement | null = null;
    if (gate.learning) {
      judgement = await this.askPrediction(explanation, io);
    }
    await io.reveal(explanation, judgement);

    const correct = judgement?.verdict === "correct";
    this.competence.record(explanation.concepts, judgement ? correct : null);

    let proceeded = true;
    if (gate.effectiveMode === "gate" && !correct) {
      // Hard gate: block until the user demonstrates understanding.
      proceeded = await io.requireUnderstanding();
    }
    return { kind: "resolved", gate, judgement, proceeded };
  }

  private async askPrediction(
    explanation: Explanation,
    io: GateIO,
  ): Promise<Judgement | null> {
    const pred = explanation.prediction;

    // Tier 3, opt-in: free-text over the same question, graded by the LLM.
    if (this.opts.deepMode && this.opts.grader) {
      const prompt = pred.kind === "selection" ? pred.question : pred.prompt;
      const answer = await io.predict(prompt);
      return this.opts.grader.judge(explanation, answer);
    }

    if (pred.kind === "selection") {
      const idx = await io.select(pred.question, pred.options);
      return gradeSelection(pred.options, idx);
    }

    // Free-text prediction without a grader: ask (committing to a prediction
    // is the mechanic), reveal without judgement.
    await io.predict(pred.prompt);
    return null;
  }
}

/** Reduce a gate outcome to a log row. Fingerprint is supplied by the caller. */
function toEntry(fp: string, outcome: GateOutcome): InteractionEntry {
  const { gate } = outcome;
  const base = {
    ts: new Date().toISOString(),
    fingerprint: fp,
    category: gate.candidate.trigger.category,
    effectiveMode: gate.effectiveMode,
    tier: gate.resolution?.tier ?? null,
    cardId: gate.resolution?.cardId,
  };
  if (outcome.kind === "observed") {
    // Observe never interrupts and never blocks: no verdict, always proceeds.
    return { ...base, verdict: null, proceeded: true };
  }
  return {
    ...base,
    verdict: outcome.judgement?.verdict ?? null,
    proceeded: outcome.proceeded,
  };
}

/** String-compare grading: zero LLM, zero tokens. */
export function gradeSelection(
  options: SelectionOption[],
  chosenIndex: number,
): Judgement {
  const chosen = options[chosenIndex];
  const correct = options.find((o) => o.correct);
  if (chosen?.correct) {
    return { verdict: "correct", note: "That's the real consequence." };
  }
  const why = chosen?.misconception ? `${chosen.misconception}` : "";
  const reality = correct ? ` The reality: ${correct.text}` : "";
  return { verdict: "incorrect", note: `${why}${reality}`.trim() };
}
