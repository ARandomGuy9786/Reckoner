import type { CategoryConfig, ReckonerConfig } from "./config.js";
import { learningActive } from "./config.js";
import type { Competence } from "./competence.js";
import type { Engine } from "./engine.js";
import type {
  AgentAction,
  Category,
  DetectedTrigger,
  Explanation,
  Judgement,
  Mode,
} from "./types.js";

// The orchestrator wires the gate loop (detect -> predict -> reveal -> branch)
// and owns the resolution order that keeps Reckoner silent by default. There is
// exactly one path from an action to a gate, and every drop point is visible in
// sequence. See src/orchestrator/README.md.

/** A trigger that survived config + competence filtering and will run. */
export interface ResolvedGate {
  trigger: DetectedTrigger;
  config: CategoryConfig;
  learning: boolean;
}

/** UI-agnostic interaction surface. The CLI supplies the real implementation. */
export interface GateIO {
  /** Announce that a gate is firing. */
  announce(gate: ResolvedGate): void | Promise<void>;
  /** Ask the user to predict; return their answer (predict-then-reveal). */
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

const MODE_RANK: Record<Mode, number> = { gate: 3, coach: 2, observe: 1, off: 0 };

export class Orchestrator {
  constructor(
    private cfg: ReckonerConfig,
    private engine: Engine,
    private competence: Competence,
  ) {}

  /** Run the full loop for a proposed action. Returns per-gate outcomes. */
  async run(action: AgentAction, io: GateIO): Promise<GateOutcome[]> {
    const gates = await this.resolve(action);
    const outcomes: GateOutcome[] = [];
    for (const gate of gates) {
      outcomes.push(await this.runGate(action, gate, io));
    }
    return outcomes;
  }

  /** detect -> config -> competence -> cap. The silent-by-default pipeline. */
  async resolve(action: AgentAction): Promise<ResolvedGate[]> {
    const triggers = await this.engine.detect(action);

    const surviving: ResolvedGate[] = [];
    for (const trigger of triggers) {
      const config = this.cfg.categories[trigger.category];
      if (config.mode === "off") continue; // drop: category disabled
      if (
        (config.mode === "coach" || config.mode === "gate") &&
        !this.competence.shouldGate(trigger.concepts)
      ) {
        continue; // drop: below the user's frontier (anti-patronizing)
      }
      surviving.push({
        trigger,
        config,
        learning: learningActive(this.cfg, trigger.category as Category),
      });
    }

    // Cap: keep the highest-stakes gates, bound friction.
    surviving.sort(
      (a, b) =>
        MODE_RANK[b.config.mode] - MODE_RANK[a.config.mode] ||
        b.trigger.confidence - a.trigger.confidence,
    );
    const cap = this.cfg.gate.maxPromptsPerAction;
    // `observe` never prompts, so it doesn't count against the cap.
    const capped: ResolvedGate[] = [];
    let prompts = 0;
    for (const g of surviving) {
      if (g.config.mode === "observe") {
        capped.push(g);
        continue;
      }
      if (prompts >= cap) continue;
      prompts += 1;
      capped.push(g);
    }
    return capped;
  }

  private async runGate(
    action: AgentAction,
    gate: ResolvedGate,
    io: GateIO,
  ): Promise<GateOutcome> {
    await io.announce(gate);

    if (gate.config.mode === "observe") {
      // Log only; never interrupt. Records the concepts as "seen".
      this.competence.record(gate.trigger.concepts, null);
      return { kind: "observed", gate };
    }

    const explanation = await this.engine.explain(action, gate.config.depth);

    let judgement: Judgement | null = null;
    if (gate.learning) {
      const prediction = await io.predict(explanation.predictPrompt);
      judgement = await this.engine.judge(explanation, prediction);
    }
    await io.reveal(explanation, judgement);

    const correct = judgement?.verdict === "correct";
    this.competence.record(
      explanation.concepts,
      judgement ? correct : null,
    );

    let proceeded = true;
    if (gate.config.mode === "gate" && !correct) {
      // Hard gate: block until the user demonstrates understanding.
      proceeded = await io.requireUnderstanding();
    }
    return { kind: "resolved", gate, judgement, proceeded };
  }
}
