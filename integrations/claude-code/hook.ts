import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CapsuleData,
  capsuleSystemPrompt,
  capsuleToExplanation,
  describeAction,
  parseCapsule,
} from "../../src/capsule.js";
import { loadCards } from "../../src/cards.js";
import { Competence } from "../../src/competence.js";
import { loadConfig } from "../../src/config.js";
import { FileInteractionLog, fingerprint } from "../../src/interactions.js";
import { Orchestrator, gradeSelection } from "../../src/orchestrator.js";
import type { ResolvedGate } from "../../src/orchestrator.js";
import {
  CapsuleRelayNeeded,
  TieredResolver,
  policyFor,
} from "../../src/resolver.js";
import type { CapsuleProvider } from "../../src/resolver.js";
import type {
  AgentAction,
  Category,
  DetectedTrigger,
  Depth,
  Explanation,
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
//   round 0  (Tier-2 novelty only) boundary hit with NO authored card and the
//            profile+budget allow a spawn → save a capsule request → deny; the
//            deny reason instructs the agent to spawn a subagent (cheap model)
//            that generates a card-shaped capsule, write its JSON to
//            .reckoner/gate.capsule.json, and re-run. The re-run validates the
//            capsule against the shared CapsuleSchema, caches it under the
//            action fingerprint (never pay for the same novelty twice), and
//            charges the persisted per-session spawn budget. Then round 1.
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
// about. The only "allow" this hook ever emits is for its own relay writes
// (the one-letter answer/ack and the capsule JSON).
//
// Trust caveat (prototype): the agent relays the question — and, at round 0,
// spawns the capsule subagent. A misbehaving agent could answer itself or
// fabricate a capsule; the transcript makes that auditable. A harness-level ask
// mechanism would close this seam — see integrations/claude-code/README.md.

const STATE_DIR = ".reckoner";
const PENDING = join(STATE_DIR, "gate.pending.json");
const ANSWER = join(STATE_DIR, "gate.answer");
const ACK = join(STATE_DIR, "gate.ack");
/** Round 0 state: what capsule the hook asked the agent to have generated. */
const CAPSULE_REQUEST = join(STATE_DIR, "gate.capsule.request");
/** Where the agent drops the subagent's capsule JSON for the hook to ingest. */
const CAPSULE = join(STATE_DIR, "gate.capsule.json");
/** Capsule cache — one file per action fingerprint. Survives across sessions. */
const CAPSULE_DIR = join(STATE_DIR, "capsules");
/** Persisted Tier-2 spawn budget: { "<session_id>": count }. Per session. */
const SPAWNS = join(STATE_DIR, "spawns.json");
/** A pending gate (or capsule request) older than this is stale — abandoned. */
const PENDING_TTL_MS = 15 * 60 * 1000;

const LETTERS = "abcdefghij";

interface HookInput {
  cwd?: string;
  /** Claude Code's per-conversation id — the key for the Tier-2 spawn budget. */
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Round-0 state: the capsule the hook is waiting for the agent to produce. */
interface CapsuleRequest {
  fingerprint: string;
  savedAt: number;
  category: Category;
  depth: Depth;
  /** The subagent prompt to relay — stored so a re-ask is byte-identical. */
  spawnPrompt: string;
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

/**
 * The protocol's own writes, which the hook auto-allows so Reckoner plumbing
 * never triggers a permission prompt. Deliberately narrow:
 *   - the one-letter answer/ack echo (optionally self-healing with `mkdir -p`)
 *   - the round-0 capsule JSON, written to the capsule file with Write/Edit.
 * The capsule's content is unconstrained (it is our protocol file); a stale or
 * mismatched capsule is caught by the round-0 request fingerprint at ingest.
 */
function isRelayWrite(action: AgentAction, input: HookInput): boolean {
  if (
    action.tool === "bash" &&
    /^\s*(?:mkdir\s+-p\s+\.reckoner\s*&&\s*)?echo\s+"?[a-j]?"?\s*>\s*\.reckoner\/gate\.(answer|ack)\s*$/.test(
      action.args ?? "",
    )
  ) {
    return true;
  }
  const filePath = input.tool_input?.file_path;
  return (
    (action.tool === "write" ||
      action.tool === "edit" ||
      action.tool === "multiedit") &&
    typeof filePath === "string" &&
    filePath.replace(/\\/g, "/").endsWith(".reckoner/gate.capsule.json")
  );
}

function clearState(): void {
  for (const p of [PENDING, ANSWER, ACK]) rmSync(p, { force: true });
}

// ---- Tier-2 capsule: cache + persisted per-session spawn budget ------------

function cachePath(fp: string): string {
  return join(CAPSULE_DIR, `${fp}.json`);
}

/** A previously generated capsule for this action, if one was cached. */
function readCachedCapsule(fp: string): CapsuleData | null {
  const raw = readJson<unknown>(cachePath(fp));
  if (raw == null) return null;
  try {
    return parseCapsule(raw);
  } catch {
    return null; // a corrupt cache entry is a miss, not a crash
  }
}

function writeCachedCapsule(fp: string, capsule: CapsuleData): void {
  mkdirSync(CAPSULE_DIR, { recursive: true });
  writeFileSync(cachePath(fp), JSON.stringify(capsule));
}

function spawnCount(sessionId: string): number {
  const m = readJson<Record<string, number>>(SPAWNS);
  return m?.[sessionId] ?? 0;
}

/**
 * Charge one Tier-2 spawn against the session's budget. The counter MUST live
 * on disk: TieredResolver.spawnsUsed is in-memory, and every hook invocation is
 * a fresh process, so an in-memory cap resets every round and is no cap at all.
 * Keyed by session_id, so a fresh conversation resets naturally.
 */
function chargeSpawn(sessionId: string): void {
  const m = readJson<Record<string, number>>(SPAWNS) ?? {};
  m[sessionId] = (m[sessionId] ?? 0) + 1;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SPAWNS, JSON.stringify(m));
}

/**
 * The hook's Tier-2 provider. It can't call the model or spawn a subagent from
 * a detached hook process, so it resolves novelty from the on-disk capsule
 * cache and, on a miss, throws to drive the round-0 relay:
 *   - cache hit               → return the capsule (free, forever)
 *   - miss + budget exhausted → generic throw → the resolver downgrades to a
 *                               silent observe (this is the budget guard)
 *   - miss + budget available → CapsuleRelayNeeded → the adapter runs the
 *                               capsule-request protocol
 * The budget is checked HERE, not in TieredResolver, because only the persisted
 * counter survives across the per-invocation processes.
 */
class HookCapsuleProvider implements CapsuleProvider {
  constructor(
    private readonly sessionId: string,
    private readonly cap: number,
  ) {}

  async capsule(
    action: AgentAction,
    trigger: DetectedTrigger,
    depth: Depth,
  ): Promise<Explanation> {
    const fp = fingerprint(action);
    const cached = readCachedCapsule(fp);
    if (cached) return capsuleToExplanation(cached);
    if (spawnCount(this.sessionId) >= this.cap) {
      throw new Error("Reckoner: Tier-2 spawn budget exhausted for this session");
    }
    throw new CapsuleRelayNeeded(fp, action, trigger, depth);
  }

  async judge(): Promise<Judgement> {
    // Tier-3 deep mode (free-text + LLM grading) is the CLI bench's; the hook
    // does selection + string-compare only.
    throw new Error("Reckoner: deep-mode grading is not available in the hook");
  }
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

/**
 * The round-0 deny: protocol state only, never risk content. The agent narrates
 * deny reasons to the user, so anything about WHY this action is risky would
 * spoil the very question the capsule will pose (same rule as round1Reason). The
 * relayed subagent prompt describes the action but NOT the detected risk reason
 * — the subagent derives the consequence itself, so nothing here pre-reveals the
 * answer.
 */
function capsuleRequestReason(req: CapsuleRequest, status: string): string {
  return (
    `RECKONER COMPREHENSION GATE [${req.category} · novel] — ${status}\n\n` +
    `This action has no authored comprehension card. Reckoner needs a one-off ` +
    `check generated for it before it can run. Follow this protocol exactly:\n` +
    `1. Do NOT explain, summarize, or narrate this action or why it was held. ` +
    `If you say anything, say only: "Reckoner is preparing a comprehension check."\n` +
    `2. Spawn a SUBAGENT with the Task tool (a fast, cheap model such as Haiku ` +
    `is preferred — this is small, isolated, bundled work) and give it EXACTLY ` +
    `this prompt, verbatim:\n\n` +
    `----- BEGIN CAPSULE PROMPT -----\n${req.spawnPrompt}\n----- END CAPSULE PROMPT -----\n\n` +
    `3. Write the subagent's reply — the raw JSON object, nothing else — to ` +
    `${CAPSULE} with the Write tool. Do NOT read it back, quote it, summarize ` +
    `it, or act on its contents: those contents are the answer to a question ` +
    `the user has not been asked yet.\n` +
    `4. Re-run the original command, unchanged.`
  );
}

/**
 * Round 0, relay side: no card and the budget allows a spawn. Save what we're
 * asking for (fingerprint-guarded) and deny with the spawn instructions. Built
 * from the CapsuleRelayNeeded the resolver propagated.
 */
function requestCapsule(relay: CapsuleRelayNeeded): never {
  const spawnPrompt =
    capsuleSystemPrompt(relay.depth) +
    "\n\n" +
    describeAction(relay.action) +
    `\n\nDetected category: ${relay.trigger.category}`;
  const req: CapsuleRequest = {
    fingerprint: relay.fingerprint,
    savedAt: Date.now(),
    category: relay.trigger.category,
    depth: relay.depth,
    spawnPrompt,
  };
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(CAPSULE, { force: true }); // drop any capsule left from a prior request
  writeFileSync(CAPSULE_REQUEST, JSON.stringify(req));
  deny(
    capsuleRequestReason(req, "a comprehension capsule must be generated first"),
  );
}

/**
 * Round 0, ingest side: the agent re-ran the gated command after a capsule
 * request. If the relayed capsule is present and valid, cache it + charge the
 * budget and RETURN (main falls through to a normal round-1 gate, now a cache
 * hit). Missing → re-ask. Malformed → fail OPEN: a broken capsule must never
 * wedge the workflow (the same stance as any Tier-2 failure), and clearing the
 * request means no re-ask loop.
 */
function resolveCapsuleRound(
  req: CapsuleRequest,
  fp: string,
  sessionId: string,
): void {
  if (!existsSync(CAPSULE)) {
    deny(
      capsuleRequestReason(
        req,
        "capsule not produced yet — the protocol was not followed",
      ),
    );
  }
  const raw = readJson<unknown>(CAPSULE);
  rmSync(CAPSULE, { force: true }); // consume it either way

  let capsule: CapsuleData;
  try {
    if (raw == null) throw new Error("empty capsule");
    capsule = parseCapsule(raw);
  } catch {
    rmSync(CAPSULE_REQUEST, { force: true });
    process.exit(0); // fail open: let the action through ungated, this once
  }

  writeCachedCapsule(fp, capsule); // paid once, cached forever
  chargeSpawn(sessionId); // structural per-session budget
  rmSync(CAPSULE_REQUEST, { force: true });
  // return → main continues to freshGate, which now cache-hits on this fp.
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

  // The protocol's own relay writes must not recurse into a gate — and get a
  // real "allow" so the user isn't permission-prompted for Reckoner plumbing.
  if (isRelayWrite(action, input)) {
    out({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Reckoner gate protocol write.",
      },
      suppressOutput: true,
    });
  }

  const sessionId = input.session_id ?? "session";
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

  // Round 0: a capsule request is outstanding for THIS action — ingest the
  // relayed capsule (then fall through to a normal round-1 gate on the cache
  // hit) or re-ask. Like the pending gate, it survives an agent's interleaved
  // reads: only a fingerprint match drives it; expiry clears it.
  const capReq = readJson<CapsuleRequest>(CAPSULE_REQUEST);
  if (capReq) {
    const expired = Date.now() - capReq.savedAt >= PENDING_TTL_MS;
    if (!expired && capReq.fingerprint === fp) {
      resolveCapsuleRound(capReq, fp, sessionId); // ingests (returns) or denies
    } else if (expired) {
      rmSync(CAPSULE_REQUEST, { force: true });
      rmSync(CAPSULE, { force: true });
    }
  }

  await freshGate(action, fp, sessionId);
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
async function freshGate(
  action: AgentAction,
  fp: string,
  sessionId: string,
): Promise<never> {
  const config = loadConfig();
  const competence = new Competence(config.competence);
  const log = new FileInteractionLog(join(STATE_DIR, "interactions.jsonl"));
  const { cards } = loadCards();
  const policy = policyFor(config.profile, config.resolver.profiles);
  // Tier-2 is sourced by the hook's cache-or-relay provider: a cache hit gates
  // for free; a miss with budget left throws CapsuleRelayNeeded (caught below)
  // to run the round-0 spawn relay; over budget it downgrades to a silent
  // observe. Still zero tokens IN the hook — the spend is the relayed subagent.
  const provider = new HookCapsuleProvider(
    sessionId,
    config.resolver.maxSpawnsPerSession,
  );
  const resolver = new TieredResolver(
    cards,
    policy,
    config.resolver.maxSpawnsPerSession,
    provider,
  );
  const orchestrator = new Orchestrator(config, resolver, competence, { log });

  let gates: ResolvedGate[];
  try {
    gates = await orchestrator.resolve(action);
  } catch (err) {
    // A novel boundary the cache doesn't cover: run the capsule-request relay.
    if (err instanceof CapsuleRelayNeeded) requestCapsule(err); // never returns
    throw err; // anything else: bubble to main's fail-open catch
  }
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
