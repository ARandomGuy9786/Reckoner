import { z } from "zod";
import type { Depth, Explanation } from "./types.js";

// The shared Tier-2 capsule contract: the schema a capsule must satisfy, the
// generation prompt, and the card-shaping helpers. Extracted from engine.ts so
// the two Tier-2 paths validate against ONE definition and can never drift:
//   - engine.ts (CLI) PRODUCES a capsule by calling the model directly, then
//     validates with CapsuleSchema.
//   - the Claude Code hook can't call the model; it relays a subagent spawn and
//     VALIDATES the returned JSON with the same CapsuleSchema before caching it.
// A capsule is card-shaped on purpose: intent -> mechanism -> consequence plus a
// selection prediction, exactly what an authored card carries, so a novel action
// gates identically to a covered one.

export const CapsuleSchema = z.object({
  intent: z.string(),
  mechanism: z.string(),
  consequence: z.string(),
  concepts: z.array(z.string()),
  selection: z.object({
    question: z.string(),
    options: z
      .array(
        z.object({
          text: z.string(),
          correct: z.boolean().optional(),
          misconception: z.string().optional(),
        }),
      )
      .min(2)
      .max(5),
  }),
});

export type CapsuleData = z.infer<typeof CapsuleSchema>;

function depthNote(depth: Depth): string {
  return depth === "concept"
    ? "Keep it to the core concept and the single most important consequence."
    : depth === "consequence"
      ? "Cover the concept and the concrete consequences: what changes, what could break."
      : "Go deep on the wiring: the protocols, tools, and how the pieces connect, plus consequences.";
}

/**
 * The capsule-generation system prompt, shared by the engine (which sends it to
 * the model) and the hook (which relays it verbatim to a spawned subagent).
 * Keeping it here means both callers phrase the ask identically.
 */
export function capsuleSystemPrompt(depth: Depth): string {
  return (
    "You are Reckoner's capsule generator. Turn a proposed agent action into a " +
    "predict-then-reveal exchange for a human who reasons about functionality " +
    "and consequences, not line-by-line code.\n" +
    "- intent: restate plainly what the human asked for.\n" +
    "- mechanism: how it will be wired — the protocols, tools, and concepts.\n" +
    "- consequence: what changes, what could break, what it costs.\n" +
    "- concepts: the concepts this exchange covers.\n" +
    "- selection: ONE sharp multiple-choice question asked BEFORE the reveal, " +
    "about a consequence the user could plausibly be wrong about (never 'what " +
    "does this do?'). 3-4 options, exactly one with \"correct\": true. Every " +
    "wrong option encodes a REAL misconception someone smart might hold, with a " +
    '"misconception" field explaining why people believe it and why it is wrong.\n' +
    depthNote(depth) +
    "\n\nRespond with ONLY a JSON object with keys intent, mechanism, " +
    "consequence, concepts (array), selection {question, options: " +
    '[{text, correct?, misconception?}]}. No prose, no markdown fences.'
  );
}

/** Render a proposed action as the user message for capsule generation. */
export function describeAction(action: {
  intent: string;
  summary: string;
  tool?: string;
  args?: string;
  detail?: string;
}): string {
  let s = `Intent (what the human asked for): ${action.intent}\n`;
  s += `Proposed action (what the agent will do): ${action.summary}`;
  if (action.tool) s += `\nTool: ${action.tool}`;
  if (action.args) s += `\nArgs: ${action.args}`;
  if (action.detail) s += `\nAdditional context: ${action.detail}`;
  return s;
}

/**
 * Pedagogy invariant: a selection must have exactly one correct option.
 * Malformed pedagogy is worse than none — the caller downgrades rather than
 * gate on a broken question.
 */
export function assertOneCorrect(capsule: CapsuleData): void {
  if (capsule.selection.options.filter((o) => o.correct).length !== 1) {
    throw new Error("capsule: selection must have exactly one correct option");
  }
}

/** Validate an untrusted capsule payload (schema + one-correct invariant). */
export function parseCapsule(raw: unknown): CapsuleData {
  const capsule = CapsuleSchema.parse(raw);
  assertOneCorrect(capsule);
  return capsule;
}

/** Shape a validated capsule into the reveal Explanation the gate loop expects. */
export function capsuleToExplanation(capsule: CapsuleData): Explanation {
  return {
    intent: capsule.intent,
    mechanism: capsule.mechanism,
    consequence: capsule.consequence,
    concepts: capsule.concepts,
    prediction: { kind: "selection", ...capsule.selection },
  };
}
