import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { Competence } from "./competence.js";
import { Engine } from "./engine.js";
import { Orchestrator } from "./orchestrator.js";
import type { GateIO, ResolvedGate } from "./orchestrator.js";
import type { AgentAction, Explanation, Judgement } from "./types.js";

// A minimal, runnable prototype of the gate loop. Point it at a proposed action
// and feel the friction of predict-then-reveal. This is the wedge that validates
// the riskiest assumption before wiring Reckoner into a PreToolUse hook.

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// A stand-in action so `npm run demo` does something real. Swap in your own via
// argv, or feed real agent actions once wired into a hook.
const DEMO_ACTION: AgentAction = {
  intent: "Let users log in with Google instead of our email/password form.",
  summary:
    "Replace the custom session-cookie auth with an OAuth2 authorization-code " +
    "flow via Google as the identity provider, storing the returned tokens and " +
    "migrating the existing users table to key accounts by Google 'sub' claim.",
  detail:
    "Touches the auth middleware, the sessions table, and adds a redirect/callback route.",
};

async function main() {
  const argAction = process.argv.slice(2).join(" ").trim();
  const action: AgentAction = argAction
    ? { intent: argAction, summary: argAction }
    : DEMO_ACTION;

  const config = loadConfig();
  const competence = new Competence(config.competence);

  if (!hasCredentials()) {
    console.error(
      c.red("\nReckoner needs Claude API credentials to run its engine.\n") +
        "Set " +
        c.bold("ANTHROPIC_API_KEY") +
        " (or run `ant auth login`) and try again.\n",
    );
    process.exit(1);
  }

  const engine = new Engine();
  const orchestrator = new Orchestrator(config, engine, competence);

  const rl = createInterface({ input: stdin, output: stdout });

  console.log(c.bold("\nReckoner") + c.dim("  — not for agents, for humans\n"));
  console.log(c.dim("Proposed action:"));
  console.log("  " + c.bold(action.intent));
  console.log(c.dim("  " + action.summary) + "\n");
  process.stdout.write(c.dim("Reckoning… "));

  const io: GateIO = {
    announce(gate: ResolvedGate) {
      process.stdout.write("\r" + " ".repeat(12) + "\r");
      const tag = `[${gate.trigger.category} · ${gate.config.mode}]`;
      console.log(c.amber(c.bold(tag)) + " " + gate.trigger.reason);
    },
    async predict(prompt: string) {
      console.log("\n" + c.cyan("Before you approve — predict:"));
      console.log("  " + prompt);
      return (await rl.question(c.cyan("\nyour prediction ▸ "))).trim();
    },
    async reveal(explanation: Explanation, judgement: Judgement | null) {
      if (judgement) {
        const mark =
          judgement.verdict === "correct"
            ? c.green("✓ correct")
            : judgement.verdict === "partial"
              ? c.amber("~ partial")
              : c.red("✗ off");
        console.log("\n" + mark + " — " + judgement.note);
      }
      console.log("\n" + c.bold("Reveal"));
      console.log(c.dim("  intent      ") + explanation.intent);
      console.log(c.dim("  mechanism   ") + explanation.mechanism);
      console.log(c.dim("  consequence ") + explanation.consequence);
    },
    async requireUnderstanding() {
      console.log(
        "\n" + c.red("This is a hard gate.") + " It stays closed until you can restate the risk.",
      );
      const ans = (
        await rl.question(
          c.bold("\nIn one sentence, what's the main consequence you're accepting? ▸ "),
        )
      ).trim();
      const ok = ans.length >= 12;
      console.log(
        ok
          ? c.green("\nGate opened. You own this decision now.")
          : c.red("\nGate held. (Prototype: needs a real answer, ≥12 chars.)"),
      );
      return ok;
    },
  };

  try {
    const outcomes = await orchestrator.run(action, io);
    process.stdout.write("\r" + " ".repeat(12) + "\r");
    if (outcomes.length === 0) {
      console.log(
        c.green("No gate fired.") +
          c.dim(" Silent by default — this action didn't clear the bar.\n"),
      );
    } else {
      const blocked = outcomes.some(
        (o) => o.kind === "resolved" && !o.proceeded,
      );
      console.log(
        "\n" +
          (blocked
            ? c.red("Approval blocked — comprehension not demonstrated.")
            : c.green("Approval cleared — informed.")) +
          "\n",
      );
    }
  } finally {
    rl.close();
  }
}

function hasCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
