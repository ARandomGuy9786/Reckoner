import type {
  AgentAction,
  DetectedTrigger,
  Depth,
  Explanation,
  Judgement,
  Mode,
} from "./types.js";
import type { Card } from "./cards.js";
import { cardMatches } from "./cards.js";
import { detectBoundaries } from "./detectors/deterministic.js";

// The tiered Resolver: reach for the cheapest source first, escalate only when
// the profile allows it. T0 deterministic detect and T1 cards are free; T2
// (spawned capsule) spends from a capped budget; T3 (deep mode) is opt-in.
// See docs/architecture.md — the budget guard makes unbudgeted LLM calls
// structurally impossible, not merely discouraged.

/** A Tier-0 hit: trigger plus provenance, before any content is resolved. */
export interface Candidate {
  trigger: DetectedTrigger;
  /** Boundary pattern that detected it (built-in table). */
  patternId?: string;
  /** Card whose own match clauses detected it (content already known). */
  cardId?: string;
}

/** Resolved content for a candidate that will actually gate. */
export interface Resolution {
  /** Which tier supplied the content. */
  tier: 1 | 2;
  source: "card" | "capsule";
  explanation: Explanation;
  cardId?: string;
}

/**
 * Tier-2/3 provider: generates a card-shaped capsule for a novel action, and
 * grades free-text predictions in deep mode. src/engine.ts implements this.
 */
export interface CapsuleProvider {
  capsule(
    action: AgentAction,
    trigger: DetectedTrigger,
    depth: Depth,
  ): Promise<Explanation>;
  judge(explanation: Explanation, prediction: string): Promise<Judgement>;
}

export type Profile = "learner" | "builder" | "expert";

/** How a profile sources and spends intelligence (docs/architecture.md table). */
export interface ResolverPolicy {
  /** When may the resolver escalate to the Tier-2 provider? */
  escalate: "always" | "gate-only" | "never";
  /** May Tier-3 deep mode (free-text + LLM grading) be enabled at all? */
  deepModeAllowed: boolean;
}

export const PROFILE_POLICIES: Record<Profile, ResolverPolicy> = {
  // Learning is the product; spend is the tuition.
  learner: { escalate: "always", deepModeAllowed: true },
  // Cards first; subagent only for novel actions at irreversible boundaries.
  builder: { escalate: "gate-only", deepModeAllowed: true },
  // Never spends a token.
  expert: { escalate: "never", deepModeAllowed: false },
};

export function policyFor(profile: string): ResolverPolicy {
  return PROFILE_POLICIES[profile as Profile] ?? PROFILE_POLICIES.builder;
}

/** Per-session cap on Tier-2 spawns (a config knob in schema v2 — Phase 2). */
const DEFAULT_SPAWN_CAP = 2;

export interface Resolver {
  /** Tier 0: deterministic, free, side-effect-free. Decides IF anything fires. */
  detect(action: AgentAction): Candidate[];
  /**
   * Tiers 1–2: content for a candidate that survived config/competence/cap.
   * Returns null when no content is affordable — the caller downgrades the
   * gate to observe rather than firing an empty one.
   */
  content(
    action: AgentAction,
    candidate: Candidate,
    mode: Mode,
    depth: Depth,
  ): Promise<Resolution | null>;
}

export class TieredResolver implements Resolver {
  private readonly provider: CapsuleProvider | null;
  private spawnsUsed = 0;

  constructor(
    private readonly cards: Card[],
    private readonly policy: ResolverPolicy,
    provider?: CapsuleProvider,
    private readonly spawnCap: number = DEFAULT_SPAWN_CAP,
  ) {
    // Budget guard: when the policy forbids escalation, the provider is not
    // even retained — Tier 2 is structurally unreachable, not just skipped.
    this.provider = this.policy.escalate === "never" ? null : (provider ?? null);
  }

  detect(action: AgentAction): Candidate[] {
    const candidates: Candidate[] = [];
    const hitPatterns = new Set<string>();

    for (const hit of detectBoundaries(action)) {
      hitPatterns.add(hit.patternId);
      candidates.push({ trigger: hit.trigger, patternId: hit.patternId });
    }

    // Cards with their own match clauses extend detection beyond the built-in
    // table (community coverage). Pattern-keyed cards are already covered.
    for (const card of this.cards) {
      if (card.pattern) continue;
      if (!cardMatches(action, card)) continue;
      candidates.push({
        trigger: {
          category: card.category,
          confidence: 1,
          reason: card.reason ?? card.title,
          concepts: card.concepts,
        },
        cardId: card.id,
      });
    }
    return candidates;
  }

  async content(
    action: AgentAction,
    candidate: Candidate,
    mode: Mode,
    depth: Depth,
  ): Promise<Resolution | null> {
    // Tier 1: a card. Free, forever.
    const card = this.findCard(action, candidate);
    if (card) {
      return {
        tier: 1,
        source: "card",
        cardId: card.id,
        explanation: cardToExplanation(action, card),
      };
    }

    // Tier 2: spawn the provider — only if the policy, mode, and budget allow.
    if (!this.canEscalate(mode)) return null;
    this.spawnsUsed += 1;
    try {
      const explanation = await this.provider!.capsule(
        action,
        candidate.trigger,
        depth,
      );
      return { tier: 2, source: "capsule", explanation };
    } catch {
      // A failed capsule must not block or crash the gate loop: downgrade.
      return null;
    }
  }

  private findCard(action: AgentAction, candidate: Candidate): Card | null {
    if (candidate.cardId) {
      return this.cards.find((c) => c.id === candidate.cardId) ?? null;
    }
    return (
      this.cards.find(
        (c) => c.pattern === candidate.patternId && cardMatches(action, c),
      ) ?? null
    );
  }

  private canEscalate(mode: Mode): boolean {
    if (!this.provider) return false;
    if (this.spawnsUsed >= this.spawnCap) return false;
    if (this.policy.escalate === "always") return true;
    if (this.policy.escalate === "gate-only") return mode === "gate";
    return false;
  }
}

/** A card is a pre-authored explanation; the intent comes from the action. */
export function cardToExplanation(action: AgentAction, card: Card): Explanation {
  return {
    intent: action.intent,
    mechanism: card.mechanism,
    consequence: card.consequence,
    prediction: {
      kind: "selection",
      question: card.selection.question,
      options: card.selection.options,
    },
    concepts: card.concepts,
  };
}
