import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { AgentAction, Category, Judgement, Mode } from "./types.js";

// The append-only interaction log: one line per gate outcome, written to
// .reckoner/interactions.jsonl. Local-only like the competence ledger — it is
// never committed or transmitted (.reckoner/ is gitignored). It records WHAT
// fired and HOW the human responded, not the raw action: the action is reduced
// to a stable fingerprint so the log carries no command text or file paths.
//
// This is a swappable seam (like Competence): the orchestrator appends through
// the InteractionLog interface, so a test or a future adapter can substitute an
// in-memory or no-op sink without touching the gate loop.

/** One row of the log. Privacy-preserving: identity is a fingerprint, not text. */
export interface InteractionEntry {
  /** ISO-8601 timestamp of the outcome. */
  ts: string;
  /** Stable, non-reversible id for the action (tool + coarse args hashed). */
  fingerprint: string;
  category: Category;
  /** What actually ran: observe, coach, or gate (post-downgrade). */
  effectiveMode: Mode;
  /** Which tier supplied content (1 card, 2 capsule); null for observe. */
  tier: 1 | 2 | null;
  /** The card that fired, when Tier 1. */
  cardId?: string;
  /** The prediction verdict, when the user was asked; null otherwise. */
  verdict: Judgement["verdict"] | null;
  /** Whether the action was allowed to proceed (gates can hold it). */
  proceeded: boolean;
}

/** Append-only sink for interaction outcomes. */
export interface InteractionLog {
  append(entry: InteractionEntry): void;
}

/**
 * A stable, non-reversible identity for an action: the tool plus its coarse
 * args, hashed. Two runs of the same command share a fingerprint; the raw
 * command never lands in the log. Falls back to the summary when no
 * tool/args are present.
 */
export function fingerprint(action: AgentAction): string {
  const identity = `${action.tool ?? ""}\0${action.args ?? action.summary}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

/** Writes each entry as one JSON line to a local JSONL file. */
export class FileInteractionLog implements InteractionLog {
  constructor(private readonly path: string) {}

  append(entry: InteractionEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
