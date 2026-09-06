/**
 * A voice config's script coverage (issue #1065): the config's authored
 * lines, read the way the engine reads the files, held against the script
 * the config extracts to. The RULES live in `@iracedeck/callout-script`
 * (`coverage.ts`) — one module for this package's per-voice test and for
 * `lint:pack`, which runs the same rules over the clip files a pack ships —
 * and this is the glue that feeds them a config: `groups` become the
 * `<group>/<name>` list, and `buildCalloutScript` produces the script.
 *
 * What a config cannot tell the rules, and the test beside this file
 * carries instead: which groups a var resolver draws from. The vocabulary
 * lives in `@iracedeck/audio-scenarios`, which depends on this package, so
 * the reading here is the one a caller without it has — a group NO script
 * step addresses is var-driven ({@link unscriptedGroupsAreVarDriven}), and
 * the bases a resolver produces INSIDE a group the script also addresses are
 * declared by shape in the test. `lint:pack` reads both off the vocabulary.
 */
import { type Coverage, coverageOf, type VarDrivenGroup } from "@iracedeck/callout-script";

import { buildCalloutScript } from "../build/callout-scripts.mjs";
import type { VoiceConfig } from "./config.ts";

/** `<group>/<name>` for every line the config authors under `groups`, the names as written. */
export function authoredNamesOf(config: VoiceConfig): string[] {
  return Object.entries(config.groups).flatMap(([group, entries]) => entries.map((entry) => `${group}/${entry.name}`));
}

/** What the config's extracted script covers of the lines the config authors. */
export function coverageOfConfig(config: VoiceConfig): Coverage {
  return coverageOf({ script: buildCalloutScript(config), authored: authoredNamesOf(config) });
}

/**
 * The var-driven reading available without the vocabulary: a group no step
 * addresses is a resolver's to pick from, and nothing here can say which of
 * its bases. A group the script DOES address is checked in full; bases a
 * resolver produces inside one are the test's `VAR_DRIVEN_BASES`.
 */
export function unscriptedGroupsAreVarDriven(coverage: Coverage): VarDrivenGroup {
  return (group) => !coverage.scriptedGroups.has(group);
}
