/**
 * Driver-name aliases in a voice config (#1580). A spelling spoken as another
 * listed name (`geoff` → `jeff`, `@iracedeck/callout-script`'s
 * `DRIVER_NAME_ALIASES`) plays its canonical's clips, so a first-party voice
 * records the canonical only: an alias entry in any of the groups a driver
 * name is spoken from (`DRIVER_NAME_GROUPS`) would cost five paid clips per
 * voice for a set the plugin already serves, and drift from it the first time
 * one is re-cut. The generator refuses such an entry, dry run included, and
 * `driver-name-aliases.test.ts` holds every first-party config to the same
 * rule and to recording every canonical.
 *
 * A third-party pack may still record an alias spelling — the plugin then
 * plays the pack's own clips for it — so this is a rule for our configs and
 * our generator, never for `lint:pack` or the scanner.
 */
import {
  DRIVER_NAME_ALIASES,
  DRIVER_NAME_GROUPS,
  type DriverNameGroup,
  stripTakeSuffix,
} from "@iracedeck/callout-script";

import type { VoiceConfig } from "./config.ts";

/** One config entry that records an alias spelling, with the canonical it is spoken as. */
export type DriverNameAliasEntry = { group: DriverNameGroup; name: string; canonical: string };

const NAME_GROUPS: ReadonlySet<string> = new Set(DRIVER_NAME_GROUPS);

/**
 * The canonical `entryName` is an alias of, when `groupName` is a driver-name
 * group and the entry's name — its take suffix folded off, as the engine reads
 * a clip — is an alias; otherwise `null`.
 */
export function driverNameAliasOf(
  groupName: string,
  entryName: string,
  aliases: Readonly<Record<string, string>> = DRIVER_NAME_ALIASES,
): string | null {
  if (!NAME_GROUPS.has(groupName)) return null;

  const base = stripTakeSuffix(entryName);

  return Object.hasOwn(aliases, base) ? aliases[base] : null;
}

/** Every entry of `voice` that records an alias spelling in a driver-name group, in config order. */
export function findDriverNameAliasEntries(
  voice: Pick<VoiceConfig, "groups">,
  aliases: Readonly<Record<string, string>> = DRIVER_NAME_ALIASES,
): DriverNameAliasEntry[] {
  const found: DriverNameAliasEntry[] = [];

  for (const group of DRIVER_NAME_GROUPS) {
    for (const entry of voice.groups[group] ?? []) {
      const canonical = driverNameAliasOf(group, entry.name, aliases);

      if (canonical !== null) found.push({ group, name: entry.name, canonical });
    }
  }

  return found;
}

/** The refusal the generator prints for an alias entry. */
export function describeDriverNameAlias(entryName: string, canonical: string): string {
  return `"${stripTakeSuffix(entryName)}" is a driver-name alias of "${canonical}" and plays its clips — record "${canonical}" instead and remove this entry`;
}
