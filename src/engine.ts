import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type {
  AgentAction,
  DetectedTrigger,
  Depth,
  Explanation,
  Judgement,
} from "./types.js";
import type { CapsuleProvider } from "./resolver.js";

// The Claude-backed Tier-2/3 provider behind the Resolver interface. The
// default path (Tier-0 detect + Tier-1 cards) never reaches this file — it
// exists for novelty: actions the card library doesn't cover yet, and opt-in
// deep-mode grading. The subject is always the reasoning chain
// (intent -> mechanism -> consequence), never the raw code. We prompt for
// strict JSON and validate with zod, so the engine works across SDK versions
// without the structured-output helper.

const MODEL = "claude-opus-4-8";

const CapsuleSchema = z.object({
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

const JudgementSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  note: z.string(),
});

export class Engine implements CapsuleProvider {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // A bare client resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` profile from the environment.
    this.client = client ?? new Anthropic();
  }

  /**
   * Tier 2: generate a card-shaped capsule (selection prediction included)
   * for a novel action no authored card covers.
   */
  async capsule(
    action: AgentAction,
    trigger: DetectedTrigger,
    depth: Depth,
  ): Promise<Explanation> {
    const depthNote =
      depth === "concept"
        ? "Keep it to the core concept and the single most important consequence."
        : depth === "consequence"
          ? "Cover the concept and the concrete consequences: what changes, what could break."
          : "Go deep on the wiring: the protocols, tools, and how the pieces connect, plus consequences.";
    const system =
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
      depthNote +
      "\n\nRespond with ONLY a JSON object with keys intent, mechanism, " +
      "consequence, concepts (array), selection {question, options: " +
      '[{text, correct?, misconception?}]}. No prose, no markdown fences.';
    const user =
      describe(action) +
      `\n\nDetected risk: ${trigger.category} — ${trigger.reason}`;
    const capsule = await this.callJSON(CapsuleSchema, system, user, 3072);

    if (capsule.selection.options.filter((o) => o.correct).length !== 1) {
      // Malformed pedagogy is worse than none — let the resolver downgrade.
      throw new Error("capsule: selection must have exactly one correct option");
    }
    return {
      intent: capsule.intent,
      mechanism: capsule.mechanism,
      consequence: capsule.consequence,
      concepts: capsule.concepts,
      prediction: { kind: "selection", ...capsule.selection },
    };
  }

  /** Tier 3 (deep mode): judge a free-text prediction against the reveal. */
  async judge(
    explanation: Explanation,
    prediction: string,
  ): Promise<Judgement> {
    const system =
      "You are Reckoner's grader. A user predicted the consequence of an action " +
      "before seeing the answer. Judge whether their prediction shows real " +
      "understanding of the actual consequence — be fair, not pedantic about wording. " +
      "verdict: correct (grasped the key consequence), partial (right instinct, " +
      "missed something material), or incorrect (missed or misunderstood it). " +
      "note: one or two sentences naming the specific gap or confirming the insight. " +
      "Address the user directly.\n\n" +
      'Respond with ONLY a JSON object: {"verdict", "note"}. No prose, no fences.';
    const question =
      explanation.prediction.kind === "selection"
        ? explanation.prediction.question
        : explanation.prediction.prompt;
    const user =
      `Question asked: ${question}\n\n` +
      `Actual consequence: ${explanation.consequence}\n\n` +
      `User's prediction: ${prediction}`;
    return this.callJSON(JudgementSchema, system, user, 1024);
  }

  private async callJSON<T>(
    schema: z.ZodType<T>,
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<T> {
    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return schema.parse(JSON.parse(stripFences(text)));
  }
}

/** Tolerate a model that wraps JSON in ```json fences despite instructions. */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

function describe(action: AgentAction): string {
  let s = `Intent (what the human asked for): ${action.intent}\n`;
  s += `Proposed action (what the agent will do): ${action.summary}`;
  if (action.tool) s += `\nTool: ${action.tool}`;
  if (action.args) s += `\nArgs: ${action.args}`;
  if (action.detail) s += `\nAdditional context: ${action.detail}`;
  return s;
}
