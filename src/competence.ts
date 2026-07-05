import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompetenceConfig } from "./config.js";

// A dead-simple local competence ledger: per-concept counts of predictions
// right/wrong plus a last-seen timestamp. Confidence decays over time. This is
// the naive first implementation of the moat — keep the shape swappable so it
// can evolve toward real knowledge-tracing. See src/competence/README.md.

interface ConceptRecord {
  seen: number;
  correct: number;
  lastSeen: number; // epoch ms
}

type Ledger = Record<string, ConceptRecord>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Below this confidence, a concept is considered above the user's frontier. */
const FRONTIER = 0.7;

export class Competence {
  private ledger: Ledger;

  constructor(private cfg: CompetenceConfig) {
    this.ledger = this.read();
  }

  /** Confidence (0..1) that the user understands a concept right now. */
  confidence(concept: string): number {
    const r = this.ledger[concept];
    if (!r || r.seen === 0) return 0;
    const base = r.correct / r.seen;
    return base * this.decay(r.lastSeen);
  }

  /**
   * Should a gate fire for these concepts, given the user's frontier?
   * True if the model is NOT confident the user already understands them.
   */
  shouldGate(concepts: string[]): boolean {
    if (!this.cfg.enabled || !this.cfg.skipBelowFrontier) return true;
    if (concepts.length === 0) return true;
    // Gate if any touched concept is at or above the user's frontier.
    return concepts.some((c) => this.confidence(c) < FRONTIER);
  }

  /** Record the outcome of a predict-then-reveal interaction. */
  record(concepts: string[], predictionCorrect: boolean | null): void {
    if (!this.cfg.enabled) return;
    const now = Date.now();
    for (const c of concepts) {
      const r = this.ledger[c] ?? { seen: 0, correct: 0, lastSeen: now };
      if (predictionCorrect !== null) {
        r.seen += 1;
        if (predictionCorrect) r.correct += 1;
      }
      r.lastSeen = now;
      this.ledger[c] = r;
    }
    this.write();
  }

  private decay(lastSeen: number): number {
    const half = this.cfg.decayHalfLifeDays;
    if (half == null) return 1;
    const ageDays = (Date.now() - lastSeen) / DAY_MS;
    return Math.pow(0.5, ageDays / half);
  }

  private read(): Ledger {
    try {
      if (!existsSync(this.cfg.ledgerPath)) return {};
      return JSON.parse(readFileSync(this.cfg.ledgerPath, "utf8")) as Ledger;
    } catch {
      return {};
    }
  }

  private write(): void {
    mkdirSync(dirname(this.cfg.ledgerPath), { recursive: true });
    writeFileSync(this.cfg.ledgerPath, JSON.stringify(this.ledger, null, 2));
  }
}
