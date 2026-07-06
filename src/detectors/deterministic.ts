import type {
  AgentAction,
  Category,
  DetectedTrigger,
  MatchClause,
} from "../types.js";

// Tier 0: deterministic boundary detection. Zero tokens, zero LLM — a table of
// irreversible-moment patterns matched against tool identity + coarse args.
// This tier decides whether anything fires at all: "silent by default" is also
// "free by default". Patterns are deliberately coarse (a command line, a file
// path) — never parsed code structure. See docs/architecture.md.

/** Does one clause match? All present fields must match; empty clauses never do. */
export function clauseMatches(action: AgentAction, clause: MatchClause): boolean {
  let fields = 0;
  if (clause.tool != null) {
    fields++;
    if (!action.tool || !new RegExp(clause.tool, "i").test(action.tool)) return false;
  }
  if (clause.args != null) {
    fields++;
    if (!action.args || !new RegExp(clause.args, "i").test(action.args)) return false;
  }
  return fields > 0;
}

export function anyClauseMatches(
  action: AgentAction,
  clauses: MatchClause[],
): boolean {
  return clauses.some((c) => clauseMatches(action, c));
}

/** A boundary pattern: an irreversible moment Tier 0 recognizes for free. */
export interface BoundaryPattern {
  id: string;
  category: Category;
  /** Human-readable why, surfaced when the gate announces itself. */
  reason: string;
  /** Concepts the moment touches — feeds the competence model. */
  concepts: string[];
  match: MatchClause[];
}

// The starter boundary set. Cards in cards/ key to these ids via their
// `pattern` field; a pattern with no card still detects (and the resolver
// decides whether it can afford content for it). For file-editing tools
// (edit/write), `args` is the file path; for bash, the command line.
export const BOUNDARY_PATTERNS: BoundaryPattern[] = [
  {
    id: "git-force-push",
    category: "blastRadius",
    reason: "Force-push replaces remote history instead of adding to it.",
    concepts: ["git-history-rewrite", "remote-divergence"],
    match: [
      { tool: "bash", args: "git\\s+push\\b.*(\\s--force(-with-lease)?\\b|\\s-f\\b)" },
    ],
  },
  {
    id: "git-history-rewrite",
    category: "blastRadius",
    reason: "Rewriting commits gives them new identities; anything based on the old ones diverges.",
    concepts: ["git-history-rewrite", "commit-immutability"],
    match: [
      { tool: "bash", args: "git\\s+(rebase|filter-branch|filter-repo)\\b|git\\s+commit\\b.*--amend" },
    ],
  },
  {
    id: "git-discard-local",
    category: "blastRadius",
    reason: "This throws away local work that was never committed — git cannot restore what it never stored.",
    concepts: ["git-working-tree", "uncommitted-work-loss"],
    match: [
      { tool: "bash", args: "git\\s+reset\\b.*--hard|git\\s+clean\\b.*\\s-\\w*f" },
    ],
  },
  {
    id: "rm-recursive-force",
    category: "blastRadius",
    reason: "Recursive delete bypasses any trash — the files are gone the moment it runs.",
    concepts: ["filesystem-unlink", "unrecoverable-delete"],
    match: [
      { tool: "bash", args: "\\brm\\s+(-[a-z]+\\s+)*-[a-z]*r[a-z]*\\b" },
    ],
  },
  {
    id: "destructive-migration",
    category: "blastRadius",
    reason: "This migration destroys data, not just schema — a down-migration cannot bring the rows back.",
    concepts: ["schema-vs-data", "migration-irreversibility"],
    match: [
      {
        tool: "bash|sql|migrat",
        args: "drop\\s+(table|database|schema|column)|truncate\\s+|delete\\s+from|migrate\\s+(reset|fresh|down|rollback)",
      },
    ],
  },
  {
    id: "secret-env-edit",
    category: "security",
    reason: "This touches a file that holds credentials — exposure here outlives the edit.",
    concepts: ["secret-exposure", "git-history-permanence", "credential-rotation"],
    match: [
      { tool: "edit|write|create", args: "(^|/)\\.env(\\.[\\w-]+)?$|secrets?\\.(json|ya?ml|toml)|credentials|\\bid_(rsa|ed25519)\\b|\\.pem$" },
      { tool: "bash", args: ">>?\\s*\\.env\\b|export\\s+\\w*(KEY|TOKEN|SECRET|PASSWORD)\\w*=" },
    ],
  },
  {
    id: "auth-change",
    category: "security",
    reason: "This changes how identity or sessions are checked — the dangerous bugs here fail silently.",
    concepts: ["auth-fail-open", "session-validation"],
    match: [
      {
        tool: "edit|write|create",
        args: "(^|[/_.-])(auth|authn|authz|oauth2?|sso|sessions?|login|jwt|rbac|acl|permissions?)([/_.-]|$)",
      },
    ],
  },
  {
    id: "paid-provisioning",
    category: "cost",
    reason: "This provisions resources that bill continuously until something explicitly destroys them.",
    concepts: ["cloud-billing", "resource-lifecycle"],
    match: [
      {
        tool: "bash",
        args: "terraform\\s+apply|pulumi\\s+up|cdk\\s+deploy|aws\\s+\\S+\\s+(create|run)-\\S+|gcloud\\s+\\S+.*\\s+create\\b|az\\s+\\S+\\s+create\\b|doctl\\s+\\S+\\s+create\\b",
      },
    ],
  },
  {
    id: "production-deploy",
    category: "blastRadius",
    reason: "This replaces what is currently serving real users.",
    concepts: ["deploy-rollback", "stateful-effects"],
    match: [
      {
        tool: "bash",
        args: "vercel\\b.*--prod|\\bdeploy\\b.*--prod|kubectl\\s+apply|fly\\s+deploy|firebase\\s+deploy|serverless\\s+deploy|git\\s+push\\s+(heroku|dokku|production)\\b|ansible-playbook",
      },
    ],
  },
  {
    id: "package-publish",
    category: "blastRadius",
    reason: "Publishing to a public registry is immediate, world-readable, and effectively permanent.",
    concepts: ["registry-permanence", "publish-irreversibility"],
    match: [
      {
        tool: "bash",
        args: "npm\\s+publish|yarn\\s+(npm\\s+)?publish|pnpm\\s+publish|cargo\\s+publish|twine\\s+upload|gem\\s+push|dotnet\\s+nuget\\s+push|mvn\\s+deploy",
      },
    ],
  },
];

/** A Tier-0 hit: the trigger plus which pattern produced it. */
export interface BoundaryHit {
  patternId: string;
  trigger: DetectedTrigger;
}

/** Run the boundary table against an action. Deterministic, side-effect-free. */
export function detectBoundaries(action: AgentAction): BoundaryHit[] {
  const hits: BoundaryHit[] = [];
  for (const p of BOUNDARY_PATTERNS) {
    if (anyClauseMatches(action, p.match)) {
      hits.push({
        patternId: p.id,
        trigger: {
          category: p.category,
          confidence: 1, // a deterministic tool+args hit is certain
          reason: p.reason,
          concepts: p.concepts,
        },
      });
    }
  }
  return hits;
}

/** Conforms to the Detector contract in src/detectors/README.md. */
export const boundaryDetector = {
  name: "deterministic-boundaries",
  detect: (action: AgentAction): DetectedTrigger[] =>
    detectBoundaries(action).map((h) => h.trigger),
};
