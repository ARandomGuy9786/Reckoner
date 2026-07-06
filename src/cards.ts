import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { stripJsonc } from "./config.js";
import type { AgentAction, MatchClause } from "./types.js";
import {
  BOUNDARY_PATTERNS,
  anyClauseMatches,
} from "./detectors/deterministic.js";

// Tier 1: authored comprehension cards. A card authored once is a gate that
// never costs a token again — this is the primary bet (docs/architecture.md).
// Cards live in cards/ at the repo root as JSONC; see cards/CLAUDE.md for the
// authoring guide.

const MatchClauseSchema = z
  .object({
    tool: z.string().min(1).optional(),
    args: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => c.tool != null || c.args != null, {
    message: "a match clause needs `tool` and/or `args`",
  });

const SelectionOptionSchema = z
  .object({
    text: z.string().min(1),
    correct: z.boolean().optional(),
    misconception: z.string().min(1).optional(),
  })
  .strict();

const SelectionSchema = z
  .object({
    question: z.string().min(1),
    options: z.array(SelectionOptionSchema).min(2).max(5),
  })
  .strict()
  .refine((s) => s.options.filter((o) => o.correct).length === 1, {
    message: "exactly one option must have `correct: true`",
  });

export const CardSchema = z
  .object({
    /** Kebab-case id; by convention the filename without extension. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Human-readable name, shown when the gate announces itself. */
    title: z.string().min(1),
    /** Key to a built-in boundary pattern id — inherits its match clauses. */
    pattern: z.string().min(1).optional(),
    /** Or: the card's own match clauses (for patterns not in the table). */
    match: z
      .union([MatchClauseSchema, z.array(MatchClauseSchema).min(1)])
      .optional(),
    category: z.enum(["blastRadius", "security", "cost", "novelty", "architecture"]),
    concepts: z.array(z.string().min(1)).min(1),
    /** Optional override of the announce line (defaults to the pattern's reason). */
    reason: z.string().min(1).optional(),
    /** How the action works — the concept, not the code. */
    mechanism: z.string().min(1),
    /** What actually happens, including what cannot be undone. */
    consequence: z.string().min(1),
    selection: SelectionSchema,
  })
  .strict()
  .refine((c) => (c.pattern != null) !== (c.match != null), {
    message: 'a card needs exactly one of `pattern` or `match`',
  });

export type Card = z.infer<typeof CardSchema>;

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CARDS_DIR = join(here, "..", "cards");

export interface CardLoadResult {
  cards: Card[];
  /** Per-file validation problems. Broken cards are skipped, not fatal. */
  problems: string[];
}

export function loadCards(dir: string = DEFAULT_CARDS_DIR): CardLoadResult {
  const cards: Card[] = [];
  const problems: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.jsonc?$/.test(f)).sort();
  } catch {
    return { cards, problems: [`cards directory not found: ${dir}`] };
  }

  const seen = new Set<string>();
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const card = CardSchema.parse(JSON.parse(stripJsonc(raw)));
      if (seen.has(card.id)) {
        problems.push(`${file}: duplicate card id "${card.id}"`);
        continue;
      }
      if (card.pattern && !BOUNDARY_PATTERNS.some((p) => p.id === card.pattern)) {
        problems.push(`${file}: unknown boundary pattern "${card.pattern}"`);
        continue;
      }
      seen.add(card.id);
      cards.push(card);
    } catch (err) {
      problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { cards, problems };
}

/** The match clauses a card responds to (its own, or its pattern's). */
export function cardClauses(card: Card): MatchClause[] {
  if (card.pattern) {
    return BOUNDARY_PATTERNS.find((p) => p.id === card.pattern)?.match ?? [];
  }
  return Array.isArray(card.match) ? card.match : [card.match!];
}

export function cardMatches(action: AgentAction, card: Card): boolean {
  return anyClauseMatches(action, cardClauses(card));
}
