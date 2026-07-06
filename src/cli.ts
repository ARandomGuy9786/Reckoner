import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadCards } from "./cards.js";
import { Competence } from "./competence.js";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { Orchestrator } from "./orchestrator.js";
import type { GateIO, ResolvedGate } from "./orchestrator.js";
import { TieredResolver, policyFor } from "./resolver.js";
import type {
  AgentAction,
  Explanation,
  Judgement,
  SelectionOption,
} from "./types.js";

// The runnable test bench for the gate loop. The default path (Tier-0 detect +
// Tier-1 cards + selection grading) runs fully offline — no API key needed.
// Credentials only unlock Tier 2 (capsules for novel actions) and Tier 3
// (--deep: free-text predictions, LLM-graded).
//
//   npm run demo                                  # the demo force-push
//   npm run demo -- git push --force origin main  # any command, treated as bash
//   npm run demo -- --deep <command>              # Tier-3 deep mode (needs a key)

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const LETTERS = "abcdefghij";

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--deep");
  const deepRequested = process.argv.includes("--deep");

  const command = argv.join(" ").trim() || "git push --force origin main";
  const action: AgentAction = {
    intent: `Run: ${command}`,
    summary: command,
    tool: "bash",
    args: command,
  };

  const config = loadConfig();
  const competence = new Competence(config.competence);
  const policy = policyFor(config.profile);

  const { cards, problems } = loadCards();
  for (const p of problems) console.error(c.red(`card problem: ${p}`));

  // Tier 2/3 exist only when credentials do; the default path never needs them.
  const engine = hasCredentials() ? new Engine() : undefined;
  const resolver = new TieredResolver(cards, policy, engine);

  const deepMode = deepRequested && Boolean(engine) && policy.deepModeAllowed;
  if (deepRequested && !deepMode) {
    console.error(
      c.dim(
        !engine
          ? "(--deep needs ANTHROPIC_API_KEY — falling back to selection)"
          : `(--deep is not available on the "${config.profile}" profile)`,
      ),
    );
  }

  const orchestrator = new Orchestrator(config, resolver, competence, {
    deepMode,
    grader: engine,
  });

  const rl = createInterface({ input: stdin, output: stdout });

  console.log(c.bold("\nReckoner") + c.dim("  — not for agents, for humans\n"));
  console.log(c.dim("Proposed action:"));
  console.log("  " + c.bold(action.summary));
  if (!engine) {
    console.log(c.dim("  (no API key: cards only — Tier 2/3 unavailable)"));
  }
  console.log();

  const io: GateIO = {
    announce(gate: ResolvedGate) {
      const src = gate.resolution
        ? gate.resolution.source === "card"
          ? ` · card:${gate.resolution.cardId}`
          : " · capsule"
        : "";
      const tag = `[${gate.candidate.trigger.category} · ${gate.effectiveMode}${src}]`;
      const paint = gate.effectiveMode === "observe" ? c.dim : c.amber;
      console.log(paint(c.bold(tag)) + " " + paint(gate.candidate.trigger.reason));
    },
    async select(question: string, options: SelectionOption[]) {
      console.log("\n" + c.cyan("Before you approve — what happens?"));
      console.log("  " + question + "\n");
      options.forEach((o, i) => {
        console.log(`  ${c.bold(`(${LETTERS[i]})`)} ${o.text}`);
      });
      for (;;) {
        const raw = (await rl.question(c.cyan("\nyour prediction ▸ "))).trim().toLowerCase();
        const idx = LETTERS.indexOf(raw);
        if (idx >= 0 && idx < options.length) return idx;
        const num = Number.parseInt(raw, 10);
        if (num >= 1 && num <= options.length) return num - 1;
        console.log(c.dim(`  (answer a–${LETTERS[options.length - 1]})`));
      }
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
        console.log("\n" + mark + (judgement.note ? " — " + judgement.note : ""));
      }
      console.log("\n" + c.bold("Reveal"));
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
    if (outcomes.length === 0) {
      console.log(
        c.green("No gate fired.") +
          c.dim(" Silent by default — this action didn't clear the bar.\n"),
      );
    } else if (outcomes.every((o) => o.kind === "observed")) {
      console.log(c.dim("\nObserved only — nothing to interrupt for.\n"));
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
