import type { Config } from "./config.ts";

/**
 * Filter applied to the voices × groups iteration in the TTS generator.
 * `null` means "no filter" — iterate all of that axis.
 */
export interface Scope {
  voices: string[] | null;
  groups: string[] | null;
}

const FLAGS = ["--voice", "--group"] as const;
type FlagName = (typeof FLAGS)[number];

function flagToKey(flag: FlagName): keyof Scope {
  return flag === "--voice" ? "voices" : "groups";
}

function splitValue(flag: FlagName, raw: string): string[] {
  const parts = raw.split(",").map((s) => s.trim());

  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(`${flag}: expected a name (got "${raw}")`);
  }

  // A leading "-" can only mean the user wrote `--group --dry-run` (forgetting
  // the value) or `--group=-foo` (typo). Kebab keys can't start with "-" per
  // the config schema, so any "-"-prefixed token is a CLI mistake — reject it
  // here rather than letting the dry-run flag get silently consumed as a name.
  const flagLike = parts.find((p) => p.startsWith("-"));

  if (flagLike !== undefined) {
    throw new Error(`${flag}: expected a name (got "${flagLike}", looks like a flag)`);
  }

  return parts;
}

/**
 * Parse `--voice` / `--group` flags out of argv. Both forms are accepted:
 *   --group acknowledgment        (value as next token)
 *   --group=acknowledgment        (equals form)
 * Values may be comma-separated and the flag may repeat; the union of all
 * values is returned, deduped while preserving first-seen order.
 *
 * Args that aren't `--voice`/`--group` (e.g. `--dry-run`) pass through
 * untouched in `remaining` so the caller can interpret them.
 *
 * Throws if a flag is followed by no value or an empty value.
 */
export function parseScopeArgs(argv: readonly string[]): { scope: Scope; remaining: string[] } {
  const acc: Record<keyof Scope, string[]> = { voices: [], groups: [] };
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    const eqFlag = FLAGS.find((f) => arg.startsWith(`${f}=`));

    if (eqFlag) {
      acc[flagToKey(eqFlag)].push(...splitValue(eqFlag, arg.slice(eqFlag.length + 1)));
      continue;
    }

    if ((FLAGS as readonly string[]).includes(arg)) {
      const flag = arg as FlagName;
      const next = argv[i + 1];

      if (next === undefined) {
        throw new Error(`${flag}: expected a name`);
      }

      acc[flagToKey(flag)].push(...splitValue(flag, next));
      i++;
      continue;
    }

    remaining.push(arg);
  }

  return {
    scope: {
      voices: acc.voices.length > 0 ? Array.from(new Set(acc.voices)) : null,
      groups: acc.groups.length > 0 ? Array.from(new Set(acc.groups)) : null,
    },
    remaining,
  };
}

/**
 * Throw with a helpful message if any requested voice/group key is missing
 * from the loaded config. Lists the unknown names and the valid options so
 * the user can correct the typo without spelunking through the config file.
 */
export function validateScope(scope: Scope, config: Config): void {
  if (scope.voices) {
    requireKnown("--voice", scope.voices, Object.keys(config.voices));
  }

  if (scope.groups) {
    requireKnown("--group", scope.groups, Object.keys(config.groups));
  }
}

function requireKnown(flag: string, requested: string[], available: string[]): void {
  const unknown = requested.filter((name) => !available.includes(name));

  if (unknown.length === 0) return;

  const formattedUnknown = unknown.map((u) => `"${u}"`).join(", ");
  const formattedAvailable = available.length > 0 ? available.join(", ") : "(none)";

  throw new Error(
    `${flag}: unknown ${unknown.length === 1 ? "name" : "names"} ${formattedUnknown}.\n  Valid: ${formattedAvailable}`,
  );
}

/**
 * Format a scope summary for log output. Returns null when no filter is set
 * (callers can use the null to skip the log line entirely).
 */
export function formatScope(scope: Scope): string | null {
  const parts: string[] = [];

  if (scope.voices) parts.push(`voices=${scope.voices.join(",")}`);

  if (scope.groups) parts.push(`groups=${scope.groups.join(",")}`);

  return parts.length > 0 ? parts.join(", ") : null;
}
