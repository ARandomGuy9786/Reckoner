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
import {
  CapsuleSchema,
  assertOneCorrect,
  capsuleSystemPrompt,
  capsuleToExplanation,
  describeAction,
} from "./capsule.js";

// The Claude-backed Tier-2/3 provider behind the Resolver interface. The
// default path (Tier-0 detect + Tier-1 cards) never reaches this file — it
// exists for novelty: actions the card library doesn't cover yet, and opt-in
// deep-mode grading. The subject is always the reasoning chain
// (intent -> mechanism -> consequence), never the raw code. We prompt for
// strict JSON and validate with zod, so the engine works across SDK versions
// without the structured-output helper. The capsule schema + prompt live in
// src/capsule.ts so the Claude Code hook validates against the exact same
// definition when it relays a capsule from a spawned subagent.

const MODEL = "claude-opus-4-8";

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
    const system = capsuleSystemPrompt(depth);
    const user =
      describeAction(action) +
      `\n\nDetected risk: ${trigger.category} — ${trigger.reason}`;
    const capsule = await this.callJSON(CapsuleSchema, system, user, 3072);
    assertOneCorrect(capsule); // malformed pedagogy → let the resolver downgrade
    return capsuleToExplanation(capsule);
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
