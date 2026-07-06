// Core types for Reckoner. The subject of a gate is the reasoning chain
// (intent -> mechanism -> consequence), NOT the code. See docs/concept.md.

export type Category =
  | "blastRadius"
  | "security"
  | "cost"
  | "novelty"
  | "architecture";

export const CATEGORIES: Category[] = [
  "blastRadius",
  "security",
  "cost",
  "novelty",
  "architecture",
];

export type Mode = "off" | "observe" | "coach" | "gate";
export type Depth = "concept" | "consequence" | "wiring";
export type LearningMode = "on" | "off" | "inherit";

/** A concept-level description of what the agent intends. Not a raw diff. */
export interface AgentAction {
  /** What the human asked for, in their words. */
  intent: string;
  /** What the agent proposes to do — the mechanism, described in concept terms. */
  summary: string;
  /** Optional extra context (files touched, tools, protocols). */
  detail?: string;
  /**
   * Tool identity, when the adapter knows it (e.g. "bash", "edit",
   * "mcp__supabase__apply_migration"). Feeds deterministic Tier-0 matching.
   */
  tool?: string;
  /**
   * Coarse args as one flat string — a command line, a file path, a migration
   * body. Deliberately coarse: Tier-0 matches tool identity + args patterns,
   * never parsed code structure.
   */
  args?: string;
}

/**
 * One deterministic match clause: case-insensitive regexes over the action's
 * tool identity and/or coarse args. All present fields must match (AND);
 * a card or pattern carries several clauses for alternatives (OR).
 */
export interface MatchClause {
  tool?: string;
  args?: string;
}

/** One option in a selection (multiple-choice) prediction. */
export interface SelectionOption {
  text: string;
  /** Exactly one option per selection is correct. */
  correct?: boolean;
  /** For wrong options: why people believe this — shown after a wrong pick. */
  misconception?: string;
}

/** Output of a detector: which trigger category an action falls into. */
export interface DetectedTrigger {
  category: Category;
  /** 0..1 — how sure the detector is this category applies. */
  confidence: number;
  /** Human-readable why, surfaced in the reveal. */
  reason: string;
  /** Concepts this action touches — feeds the competence model. */
  concepts: string[];
}

/** The reveal produced by an explainer, rendered at the configured depth. */
export interface Explanation {
  intent: string;
  mechanism: string;
  consequence: string;
  /** The question asked BEFORE reveal (predict-then-reveal). */
  predictPrompt: string;
  concepts: string[];
}

/** How the reveal judged the user's prediction. */
export interface Judgement {
  verdict: "correct" | "partial" | "incorrect";
  /** One or two sentences teaching the gap between prediction and reality. */
  note: string;
}
