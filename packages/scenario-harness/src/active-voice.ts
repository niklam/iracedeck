/**
 * The Race Engineer voice the harness plays (issue #1144).
 *
 * The harness has a kind of voice no plugin has any more: the audio-assets
 * source tree's, under its BARE id (`default`), beside any pack under
 * `IRACEDECK_VOICE_PACKS_PATH`, whose voices are composite (`default::default`).
 * deck-core's `resolveActiveRaceEngineerVoice` reads every bare stored value as
 * a selection from before voice ids were namespaced and qualifies it — so on
 * its own it would turn the harness's `default` into an installed
 * `default::default`, and the source tree's voice, the one the harness exists
 * to audition, could no longer be picked. A stored value that is itself one of
 * the available voices is therefore taken as it is; anything else goes through
 * the plugins' own resolver, fallbacks and all.
 */
import { resolveActiveRaceEngineerVoice } from "@iracedeck/deck-core";

export function resolveHarnessVoice(stored: unknown, availableVoices: readonly string[]): string | null {
  if (typeof stored === "string" && stored.length > 0 && availableVoices.includes(stored)) return stored;

  return resolveActiveRaceEngineerVoice(availableVoices);
}
