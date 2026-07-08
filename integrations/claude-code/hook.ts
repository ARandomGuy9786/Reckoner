import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCards } from "../../src/cards.js";
import { Competence } from "../../src/competence.js";
import { loadConfig } from "../../src/config.js";
import { FileInteractionLog, fingerprint } from "../../src/interactions.js";
import { Orchestrator, gradeSelection } from "../../src/orchestrator.js";
import type { ResolvedGate } from "../../src/orchestrator.js";
import { TieredResolver, policyFor } from "../../src/resolver.js";
import type {
  AgentAction,
  Category,
  Judgement,
  SelectionOption,
} from "../../src/types.js";

// Reckoner as a Claude Code PreToolUse hook — the Phase-3 adapter.
//
// Constraint that shapes everything here: hooks run WITHOUT a controlling
// terminal (no /dev/tty), so the predict-then-reveal exchange cannot happen
// inside the hook process. Instead it runs as a small state machine across
// hook invocations — the DENY-RELAY PROTOCOL:
//
//   round 1  detect → save pending gate → deny; the deny reason instructs the
//            agent to present the selection to the USER verbatim (via
//            AskUserQuestion), write the chosen letter to .reckoner/gate.answer,
//            and re-run the same command.
//   round 2  same action + answer present → grade (string compare, zero LLM),
//            record to the competence ledger + interaction log, and:
//              correct        → defer + reveal via systemMessage
//              wrong (coach)  → defer + teach via systemMessage
//              wrong (gate)   → deny again with the reveal; require an explicit
//                               understanding-ack (.reckoner/gate.ack)
//   round 3  (gate only) ack present → defer + systemMessage.
//
// "Defer" = exit 0 with no permissionDecision: the action falls through to the
// NORMAL permission flow. Reckoner gates comprehension, not permission — it
// must never auto-allow something the user's own settings would have asked
// about. The only "allow" this hook ever emits is for its own relay write.
//
// Trust caveat (prototype): the agent relays the question. A misbehaving agent
// could answer itself; the transcript makes that auditable. A harness-level ask
// mechanism would close this seam — see integrations/claude-code/README.md.

const STATE_DIR = ".reckoner";
const PENDING = join(STATE_DIR, "gate.pending.json");
const ANSWER = join(STATE_DIR, "gate.answer");
const ACK = join(STATE_DIR, "gate.ack");
/** A pending gate older than this is stale — the exchange was abandoned. */
const PENDING_TTL_MS = 15 * 60 * 1000;

const LETTERS = "abcdefghij";

interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface PendingGate {
  fingerprint: string;
  savedAt: number;
  mode: "coach" | "gate";
  category: Category;
  cardId?: string;
  tier: 1 | 2;
  question: string;
  options: SelectionOption[];
  mechanism: string;
  consequence: string;
  concepts: string[];
  /** Set once a wrong answer was graded and we're waiting on the ack. */
  awaitingAck?: boolean;
  verdict?: Judgement["verdict"];
}

function out(obj: unknown): never {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

function defer(systemMessage?: string): never {
  out(systemMessage ? { systemMessage } : {});
}

function deny(reason: string, systemMessage?: string): never {
  out({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    ...(systemMessage ? { systemMessage } : {}),
  });
}

/** Map a PreToolUse payload onto the concept-level AgentAction. Coarse on purpose. */
function toAction(input: HookInput): AgentAction | null {
  const tool = (input.tool_name ?? "").toLowerCase();
  const ti = input.tool_input ?? {};
  if (!tool) return null;
  let args: string;
  if (typeof ti.command === "string") args = ti.command;
  else if (typeof ti.file_path === "string") args = ti.file_path;
  else args = JSON.stringify(ti);
  const summary = args.length > 200 ? args.slice(0, 200) + "…" : args;
  return {
    intent:
      typeof ti.description === "string" && ti.description
        ? ti.description
        : `Run: ${summary}`,
    summary,
    tool,
    args,
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function clearState(): void {
  for (const p of [PENDING, ANSWER, ACK]) rmSync(p, { force: true });
}

/**
 * The user-visible payload. The frame ("this is a prediction check", what a
 * wrong answer costs) must live INSIDE the verbatim text: AskUserQuestion
 * strips all surrounding context, so anything only said to the agent never
 * reaches the user — dogfooding showed a bare question reads as the agent
 * asking a preference, which kills the predict-then-reveal mechanic.
 */
function formatQuestion(p: PendingGate): string {
  const stakes =
    p.mode === "gate"
      ? "If you answer wrong, the action stays blocked until you've read the real consequence and explicitly accept it."
      : "A wrong answer won't block the action — you'll see the real consequence either way.";
  const opts = p.options
    .map((o, i) => `  (${LETTERS[i]}) ${o.text}`)
    .join("\n");
  return (
    `Reckoner prediction check — exactly one option is correct; the answer is ` +
    `revealed after you commit. ${stakes}\n\n${p.question}\n${opts}`
  );
}

/**
 * The deny reason for round 1: the exchange, plus the relay protocol.
 * `status` is protocol state ("answer file missing", …), NEVER the trigger's
 * risk summary: agents narrate deny reasons to the user, and a risk summary
 * above the question is the answer to the question (third dogfood finding —
 * the user got the explanation first, inverting predict-then-reveal).
 */
function round1Reason(p: PendingGate, status: string): string {
  return (
    `RECKONER COMPREHENSION GATE [${p.category} · ${p.mode}] — ${status}\n\n` +
    `Before this action can run, the USER must answer a prediction question. ` +
    `Follow this protocol exactly:\n` +
    `1. Do NOT explain why this action was held. Any description of the risk ` +
    `or consequence is the ANSWER to the question below, and revealing it ` +
    `defeats the check. If you say anything about this denial, say only: ` +
    `"Reckoner is holding this action behind a prediction check."\n` +
    `2. Present the question below to the user with the AskUserQuestion tool: ` +
    `header "Reckoner", question text and options VERBATIM — including the ` +
    `"prediction check" preamble. This is Reckoner's question, not yours: add ` +
    `NO commentary before or after it, do NOT answer it yourself, do NOT hint ` +
    `at the answer, do NOT explain the options.\n` +
    `3. Write the letter of the user's choice to ${ANSWER} ` +
    `(e.g. \`mkdir -p ${STATE_DIR} && echo "b" > ${ANSWER}\`).\n` +
    `4. Re-run the original command, unchanged.\n\n` +
    `QUESTION:\n${formatQuestion(p)}`
  );
}

function revealText(p: PendingGate, judgement: Judgement): string {
  const mark =
    judgement.verdict === "correct" ? "✓ correct" : `✗ ${judgement.verdict}`;
  return (
    `Reckoner ${mark}${judgement.note ? ` — ${judgement.note}` : ""}\n` +
    `mechanism: ${p.mechanism}\n` +
    `consequence: ${p.consequence}`
  );
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  } catch {
    process.exit(0); // unreadable input: fail open, silently
  }

  // Everything state-ful (ledger, log, gate state) lives in the HOOKED
  // project's .reckoner/, so competence is per-project. Cards + config load
  // from the Reckoner repo via their own import.meta-relative defaults.
  if (input.cwd) process.chdir(input.cwd);

  const action = toAction(input);
  if (!action) process.exit(0);

  // The protocol's own relay write must not recurse into a gate — and gets a
  // real "allow" so the user isn't permission-prompted for Reckoner plumbing.
  // Deliberately narrow: a bare echo of one letter into the answer/ack file,
  // optionally preceded by the exact mkdir that makes the write self-healing
  // when .reckoner/ was removed mid-exchange.
  if (
    action.tool === "bash" &&
    /^\s*(?:mkdir\s+-p\s+\.reckoner\s*&&\s*)?echo\s+"?[a-j]?"?\s*>\s*\.reckoner\/gate\.(answer|ack)\s*$/.test(
      action.args ?? "",
    )
  ) {
    out({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Reckoner gate protocol write.",
      },
      suppressOutput: true,
    });
  }

  const fp = fingerprint(action);
  const pending = readJson<PendingGate>(PENDING);

  if (pending) {
    const expired = Date.now() - pending.savedAt >= PENDING_TTL_MS;
    if (!expired && pending.fingerprint === fp) {
      resumeGate(pending); // rounds 2/3 — always exits
    }
    if (expired) clearState(); // abandoned exchange: start over
    // A DIFFERENT action while a gate is pending must NOT destroy the gate.
    // Agents routinely interleave reads/checks between relaying the question
    // and re-running the gated command; clearing state here re-opened the
    // gate on every re-run — the "asks the same question forever" loop.
    // The pending gate survives; freshGate() overwrites it only if this
    // action itself fires a gate of its own.
  }

  await freshGate(action, fp);
}

/** Rounds 2 and 3: grade the relayed answer / check the understanding ack. */
function resumeGate(p: PendingGate): never {
  const config = loadConfig();
  const competence = new Competence(config.competence);
  const log = new FileInteractionLog(join(STATE_DIR, "interactions.jsonl"));

  if (p.awaitingAck) {
    // Round 3 (gate mode, wrong answer already graded + logged).
    if (existsSync(ACK)) {
      // Second log line for the same gate: the grading line said
      // proceeded:false; this one records that understanding was confirmed
      // and the action went through. Append-only = event log, not summary.
      log.append({
        ts: new Date().toISOString(),
        fingerprint: p.fingerprint,
        category: p.category,
        effectiveMode: p.mode,
        tier: p.tier,
        cardId: p.cardId,
        verdict: p.verdict ?? null,
        proceeded: true,
      });
      clearState();
      defer(
        "Reckoner: understanding confirmed — gate opened. You own this decision now.",
      );
    }
    deny(
      `RECKONER GATE still closed: the user has not confirmed understanding yet. ` +
        `Ask the user with AskUserQuestion (header "Reckoner"), VERBATIM: ` +
        `"Proceeding means accepting this consequence: ${p.consequence} — ` +
        `do you understand and accept it?" with options "Accept and proceed" ` +
        `and "Abandon the action". Only if they accept: write the ack ` +
        `(\`mkdir -p ${STATE_DIR} && echo > ${ACK}\`) and re-run the original command.`,
    );
  }

  if (!existsSync(ANSWER)) {
    // The agent re-ran the command without relaying an answer. Re-issue.
    deny(round1Reason(p, "answer file missing — the protocol was not followed"));
  }

  const raw = readFileSync(ANSWER, "utf8").trim().toLowerCase();
  const idx = LETTERS.indexOf(raw);
  if (idx < 0 || idx >= p.options.length) {
    rmSync(ANSWER, { force: true });
    deny(
      round1Reason(p, `invalid answer "${raw}" — relay one letter a–${LETTERS[p.options.length - 1]}`),
    );
  }

  const judgement = gradeSelection(p.options, idx);
  const correct = judgement.verdict === "correct";
  competence.record(p.concepts, correct);
  log.append({
    ts: new Date().toISOString(),
    fingerprint: p.fingerprint,
    category: p.category,
    effectiveMode: p.mode,
    tier: p.tier,
    cardId: p.cardId,
    verdict: judgement.verdict,
    proceeded: correct || p.mode === "coach",
  });

  if (correct || p.mode === "coach") {
    clearState();
    defer(revealText(p, judgement));
  }

  // Hard gate + wrong answer: teach, then require an explicit ack.
  writeFileSync(
    PENDING,
    JSON.stringify({ ...p, awaitingAck: true, verdict: judgement.verdict }),
  );
  deny(
    `RECKONER GATE held — the user's prediction was wrong.\n\n` +
      `Show the user this reveal, verbatim:\n${revealText(p, judgement)}\n\n` +
      `Then ask the user with AskUserQuestion (header "Reckoner") this ` +
      `question, VERBATIM, so what they accept is in front of them:\n` +
      `"Proceeding means accepting this consequence: ${p.consequence} — ` +
      `do you understand and accept it?" with options "Accept and proceed" ` +
      `and "Abandon the action". Add no commentary of your own. Only if they ` +
      `accept: write the ack (\`mkdir -p ${STATE_DIR} && echo > ${ACK}\`) and ` +
      `re-run the original command. If they decline, abandon the action.`,
  );
}

/** Round 1 (or a fully silent pass-through): resolve and maybe open a gate. */
async function freshGate(action: AgentAction, fp: string): Promise<never> {
  const config = loadConfig();
  const competence = new Competence(config.competence);
  const log = new FileInteractionLog(join(STATE_DIR, "interactions.jsonl"));
  const { cards } = loadCards();
  const policy = policyFor(config.profile, config.resolver.profiles);
  // No capsule provider in the hook yet: cards only (Tier 0/1, zero tokens).
  // The Tier-2 spawn protocol from hook context is still an open flag.
  const resolver = new TieredResolver(
    cards,
    policy,
    config.resolver.maxSpawnsPerSession,
  );
  const orchestrator = new Orchestrator(config, resolver, competence, { log });

  const gates = await orchestrator.resolve(action);
  if (gates.length === 0) process.exit(0); // silent by default

  // Observe-only outcomes: record + log, never interrupt, stay silent.
  const interactive = gates.find(
    (g): g is ResolvedGate & { resolution: NonNullable<ResolvedGate["resolution"]> } =>
      (g.effectiveMode === "coach" || g.effectiveMode === "gate") &&
      g.resolution !== null,
  );
  for (const g of gates) {
    if (g === interactive) continue;
    competence.record(g.candidate.trigger.concepts, null);
    log.append({
      ts: new Date().toISOString(),
      fingerprint: fp,
      category: g.candidate.trigger.category,
      effectiveMode: "observe",
      tier: g.resolution?.tier ?? null,
      cardId: g.resolution?.cardId,
      verdict: null,
      proceeded: true,
    });
  }
  if (!interactive) process.exit(0);

  const ex = interactive.resolution.explanation;
  if (ex.prediction.kind !== "selection") process.exit(0); // hook does selection only
  if (!interactive.learning) {
    // learningMode off: plain-explain via systemMessage, never block.
    competence.record(ex.concepts, null);
    log.append({
      ts: new Date().toISOString(),
      fingerprint: fp,
      category: interactive.candidate.trigger.category,
      effectiveMode: interactive.effectiveMode,
      tier: interactive.resolution.tier,
      cardId: interactive.resolution.cardId,
      verdict: null,
      proceeded: true,
    });
    defer(`Reckoner [${interactive.candidate.trigger.category}]:\nmechanism: ${ex.mechanism}\nconsequence: ${ex.consequence}`);
  }

  const p: PendingGate = {
    fingerprint: fp,
    savedAt: Date.now(),
    mode: interactive.effectiveMode as "coach" | "gate",
    category: interactive.candidate.trigger.category,
    cardId: interactive.resolution.cardId,
    tier: interactive.resolution.tier,
    question: ex.prediction.question,
    options: ex.prediction.options,
    mechanism: ex.mechanism,
    consequence: ex.consequence,
    concepts: ex.concepts,
  };
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(ANSWER, { force: true });
  rmSync(ACK, { force: true });
  writeFileSync(PENDING, JSON.stringify(p));
  // The trigger's risk summary (candidate.trigger.reason) deliberately does
  // NOT go into the deny — see round1Reason. It still reaches the ledger/log
  // and the post-answer reveal via mechanism/consequence.
  deny(round1Reason(p, "a prediction check is required first"));
}

main().catch(() => {
  // Any unexpected failure fails OPEN: a broken gate must never wedge the
  // user's workflow (same stance as the pre-push guard).
  process.exit(0);
});
