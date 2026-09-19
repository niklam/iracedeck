import type { VoiceConfig } from "./config.ts";

/**
 * Filter applied to the voices × groups × entries iteration in the TTS
 * generator. `null` means "no filter" — iterate all of that axis.
 */
export interface Scope {
  voices: string[] | null;
  groups: string[] | null;
  /**
   * Entry NAMES — the `<name>` half of `<group>/<name>` — matched in every
   * group the scope iterates. This is the axis `--group` cannot express: a
   * slice of ONE large group. It exists because of #1127, where the
   * maintainer wanted to hear 21 of the 1,110 `car-number` clips spliced
   * onto a re-texted lead-in before paying for the other 1,089; without it
   * the only ways to cut a slice were a temporary config edit or a
   * four-figure re-cut. Entries outside the slice keep their manifest rows,
   * so an unscoped dry-run afterwards still reports them as out of date.
   */
  entries: string[] | null;
}

const FLAGS = ["--voice", "--group", "--entry"] as const;
type FlagName = (typeof FLAGS)[number];

const FLAG_KEYS: Record<FlagName, keyof Scope> = {
  "--voice": "voices",
  "--group": "groups",
  "--entry": "entries",
};

function flagToKey(flag: FlagName): keyof Scope {
  return FLAG_KEYS[flag];
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
 * Parse `--voice` / `--group` / `--entry` flags out of argv. Both forms are
 * accepted:
 *   --group acknowledgment        (value as next token)
 *   --group=acknowledgment        (equals form)
 * Values may be comma-separated and the flag may repeat; the union of all
 * values is returned, deduped while preserving first-seen order.
 *
 * Args that aren't one of the three flags (e.g. `--dry-run`) pass through
 * untouched in `remaining` so the caller can interpret them.
 *
 * Throws if a flag is followed by no value or an empty value.
 */
export function parseScopeArgs(argv: readonly string[]): { scope: Scope; remaining: string[] } {
  const acc: Record<keyof Scope, string[]> = { voices: [], groups: [], entries: [] };
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

  const axis = (values: string[]): string[] | null => (values.length > 0 ? Array.from(new Set(values)) : null);

  return {
    scope: {
      voices: axis(acc.voices),
      groups: axis(acc.groups),
      entries: axis(acc.entries),
    },
    remaining,
  };
}

/**
 * Throw with a helpful message if any requested voice/group/entry key is
 * missing from the loaded voice configs. Lists the unknown names and the
 * valid options so the user can correct the typo without spelunking through
 * the config files.
 *
 * Voice ids come from the `configs/*.voice.json` filename stems. Group
 * names come from the union of `groups` across every loaded voice — so a
 * `--group <name>` filter is accepted as long as *at least one* voice
 * defines that group. Voices are not held to the same group set (parity is
 * deliberately not enforced since #1065; `script-coverage.test.ts` holds
 * each voice to its own script instead), so the union is the right answer,
 * not merely a permissive one.
 *
 * Entry names are checked the same way, against the union of entry names in
 * the groups the scope would iterate — every group when there is no group
 * filter, the named ones otherwise — across the voices it would iterate. So
 * `--group car-number --entry 09` is accepted while `--group caution
 * --entry 09` is refused: an entry filter that matches nothing in its scope
 * is a typo, and the alternative (a run that reports "0 generated" and
 * looks like a full cache hit) is exactly the silent no-op that a paid API
 * should never leave a maintainer guessing about.
 */
export function validateScope(scope: Scope, voiceConfigs: Map<string, VoiceConfig>): void {
  if (scope.voices) {
    requireKnown("--voice", scope.voices, Array.from(voiceConfigs.keys()));
  }

  if (scope.groups) {
    const groups = new Set<string>();

    for (const voice of voiceConfigs.values()) {
      for (const groupName of Object.keys(voice.groups)) groups.add(groupName);
    }

    requireKnown("--group", scope.groups, Array.from(groups).sort());
  }

  if (scope.entries) {
    const entries = new Set<string>();

    for (const [voiceId, voice] of voiceConfigs) {
      if (scope.voices && !scope.voices.includes(voiceId)) continue;

      for (const [groupName, groupEntries] of Object.entries(voice.groups)) {
        if (scope.groups && !scope.groups.includes(groupName)) continue;

        for (const entry of groupEntries) entries.add(entry.name);
      }
    }

    requireKnown("--entry", scope.entries, Array.from(entries).sort());
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

  if (scope.entries) parts.push(`entries=${scope.entries.join(",")}`);

  return parts.length > 0 ? parts.join(", ") : null;
}
