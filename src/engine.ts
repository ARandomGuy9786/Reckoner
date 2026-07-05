import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type {
  AgentAction,
  DetectedTrigger,
  Depth,
  Explanation,
  Judgement,
} from "./types.js";

// Reckoner's own engine calls Claude. The subject is always the reasoning chain
// (intent -> mechanism -> consequence), never the raw code — this keeps the
// engine language-agnostic. We prompt for strict JSON and validate with zod, so
// the engine works across SDK versions without the structured-output helper.

const MODEL = "claude-opus-4-8";

const TriggerSchema = z.object({
  triggers: z.array(
    z.object({
      category: z.enum([
        "blastRadius",
        "security",
        "cost",
        "novelty",
        "architecture",
      ]),
      confidence: z.number(),
      reason: z.string(),
      concepts: z.array(z.string()),
    }),
  ),
});

const ExplanationSchema = z.object({
  intent: z.string(),
  mechanism: z.string(),
  consequence: z.string(),
  predictPrompt: z.string(),
  concepts: z.array(z.string()),
});

const JudgementSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  note: z.string(),
});

export class Engine {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // A bare client resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` profile from the environment.
    this.client = client ?? new Anthropic();
  }

  /** Classify an action into trigger categories. */
  async detect(action: AgentAction): Promise<DetectedTrigger[]> {
    const system =
      "You are Reckoner's detector. Classify a proposed agent action into risk " +
      "categories a human should understand before approving. Reason at the level " +
      "of intent, mechanism, and consequence — not lines of code. Categories: " +
      "blastRadius (reversibility/scope of damage: deletes, migrations, force-push, " +
      "infra teardown), security (auth, secrets, permissions, network exposure), " +
      "cost (paid APIs, provisioning, spending money), novelty (concepts/protocols/" +
      "tools likely new to the user), architecture (cross-cutting changes; how things " +
      "are wired). Emit only categories that genuinely apply, each with a 0..1 " +
      "confidence, a one-sentence reason, and the underlying concepts it touches. " +
      "Return an empty list for trivial, localized, fully-reversible actions.\n\n" +
      'Respond with ONLY a JSON object: {"triggers": [{"category", "confidence", ' +
      '"reason", "concepts": []}]}. No prose, no markdown fences.';
    const out = await this.callJSON(TriggerSchema, system, describe(action), 2048);
    return out.triggers;
  }

  /** Produce the reveal for a triggered action, at the requested depth. */
  async explain(action: AgentAction, depth: Depth): Promise<Explanation> {
    const depthNote =
      depth === "concept"
        ? "Keep it to the core concept and the single most important consequence."
        : depth === "consequence"
          ? "Cover the concept and the concrete consequences: what changes, what could break."
          : "Go deep on the wiring: the protocols, tools, and how the pieces connect, plus consequences.";
    const system =
      "You are Reckoner's explainer. Turn a proposed agent action into a " +
      "predict-then-reveal exchange for a human who reasons about functionality " +
      "and consequences, not line-by-line code.\n" +
      "- intent: restate plainly what the human asked for.\n" +
      "- mechanism: how it will be wired — the protocols, tools, and concepts.\n" +
      "- consequence: what changes, what could break, what it costs.\n" +
      "- predictPrompt: ONE sharp question asked BEFORE the reveal that makes the " +
      "user predict a consequence they could be wrong about (not 'what does this do?'). " +
      "The gap between their guess and reality is the whole point.\n" +
      "- concepts: the concepts this exchange covers.\n" +
      depthNote +
      "\n\nRespond with ONLY a JSON object matching keys " +
      "intent, mechanism, consequence, predictPrompt, concepts (array). " +
      "No prose, no markdown fences.";
    return this.callJSON(ExplanationSchema, system, describe(action), 3072);
  }

  /** Judge the user's prediction against the real consequence. */
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
    const user =
      `Question asked: ${explanation.predictPrompt}\n\n` +
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
  if (action.detail) s += `\nAdditional context: ${action.detail}`;
  return s;
}
