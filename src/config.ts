import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Category, Depth, LearningMode, Mode } from "./types.js";
import { CATEGORIES } from "./types.js";
import type { ResolverPolicy } from "./resolver.js";
import { DEFAULT_PROFILE_POLICIES } from "./resolver.js";

export interface CategoryConfig {
  mode: Mode;
  depth: Depth;
  learningMode: LearningMode;
}

export interface ResolverConfig {
  /** Per-session cap on Tier-2 subagent spawns — the budget guard's bound. */
  maxSpawnsPerSession: number;
  /** How each profile sources and spends intelligence (escalate + deep mode). */
  profiles: Record<string, ResolverPolicy>;
}

export interface CompetenceConfig {
  enabled: boolean;
  ledgerPath: string;
  skipBelowFrontier: boolean;
  decayHalfLifeDays: number | null;
}

export interface ReckonerConfig {
  version: number;
  profile: string;
  learningMode: boolean;
  competence: CompetenceConfig;
  resolver: ResolverConfig;
  categories: Record<Category, CategoryConfig>;
  gate: { maxPromptsPerAction: number };
}

/** Shipped resolver defaults, applied when the config omits the section. */
const DEFAULT_RESOLVER: ResolverConfig = {
  maxSpawnsPerSession: 2,
  profiles: DEFAULT_PROFILE_POLICIES,
};

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(here, "..", "config", "reckoner.jsonc");

/**
 * Strip // line comments and block comments from JSONC, respecting string
 * literals so a `//` inside a value or a URL is left intact.
 * (Also used by the card loader.)
 */
export function stripJsonc(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++; // land on the closing '/'
      continue;
    }
    out += c;
  }
  return out;
}

/** Whether learning mode is active for a category, resolving `inherit`. */
export function learningActive(
  cfg: ReckonerConfig,
  cat: Category,
): boolean {
  const lm = cfg.categories[cat].learningMode;
  if (lm === "on") return true;
  if (lm === "off") return false;
  return cfg.learningMode;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): ReckonerConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(stripJsonc(raw)) as ReckonerConfig;

  // Minimal validation — every category the engine knows about must be present.
  for (const cat of CATEGORIES) {
    if (!parsed.categories?.[cat]) {
      throw new Error(`config: missing category "${cat}" in ${path}`);
    }
  }

  // Backward-compat: a v1 config (no resolver section) still loads with the
  // shipped defaults. The budget guard is unaffected — the cap is always set.
  parsed.resolver = {
    maxSpawnsPerSession:
      parsed.resolver?.maxSpawnsPerSession ?? DEFAULT_RESOLVER.maxSpawnsPerSession,
    profiles: parsed.resolver?.profiles ?? DEFAULT_RESOLVER.profiles,
  };
  return parsed;
}
