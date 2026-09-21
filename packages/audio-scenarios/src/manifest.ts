/**
 * Audio-asset manifest types + helpers, extracted to break the
 * interpreter ↔ validation circular import. Both modules consume these
 * symbols, so they live in a leaf module that depends on neither.
 */
import { qualifiedVoiceId, stripTakeSuffix } from "@iracedeck/callout-script";

/** Manifest shape the scenario engine consumes; matches `@iracedeck/audio-assets/manifest.json`. */
export type AudioAssetsManifest = {
  clips: string[];
  ambientLoop: string;
  ticks: { open: string; close: string };
};

/**
 * Derive the set of voice keys present in a manifest by inspecting paths
 * under `voice/<voice>/…`. Used when validating `{voice}`-templated paths.
 */
export function manifestVoices(manifest: AudioAssetsManifest): Set<string> {
  const voices = new Set<string>();

  for (const clip of manifest.clips) {
    if (!clip.startsWith("voice/")) continue;

    const segments = clip.split("/");

    if (segments.length >= 2 && segments[1].length > 0) voices.add(segments[1]);
  }

  return voices;
}

/**
 * Sorted array of available Race Engineer voice keys (e.g. `"luca"`,
 * `"titan"`) — the keys the plugin offers in the PI dropdown and seeds
 * `raceEngineerVoice` from. Thin wrapper over {@link manifestVoices} that
 * normalizes the result for UI use.
 */
export function scanRaceEngineerVoices(manifest: AudioAssetsManifest): string[] {
  return Array.from(manifestVoices(manifest)).sort();
}

/**
 * The voice used for load-time typo guards (issue #664): the canonical
 * `default` voice when present, else the first sorted voice, else `null`.
 * Per-voice clip sets may legitimately diverge — voices can carry different
 * variant counts or omit a callout — so validation checks `{voice}`-templated
 * paths against this single reference voice instead of requiring parity
 * across all voices.
 *
 * The canonical voice has two spellings since voice ids are namespaced by
 * pack (#1144): the bare `default` of the source tree — the harness and the
 * tests — and `default::default`, the managed pack's voice as the plugin's
 * manifest carries it. Both are preferred, bare first, because a plain sort
 * would otherwise make any pack whose id sorts before `default` the
 * reference.
 */
export function referenceVoice(manifest: AudioAssetsManifest): string | null {
  const voices = scanRaceEngineerVoices(manifest);

  if (voices.length === 0) return null;

  return CANONICAL_VOICES.find((voice) => voices.includes(voice)) ?? voices[0];
}

const CANONICAL_VOICES = ["default", qualifiedVoiceId("default", "default")] as const;

/**
 * Sorted array of available driver-name keys (the names the engineer can
 * address the user as) derived from `voice/<voice>/names/<name>.mp3`
 * paths. The set is the union across voices — a name only present for one
 * voice still shows up; runtime playback skips gracefully when the active
 * voice has no clip for the chosen name.
 *
 * A name is a pool BASE, because that is how it is spoken: the engine plays
 * the chosen name as the `<name>` pool of each greeting group
 * (`session-start-greeting/<name>` and its siblings), and its pool rule
 * (`poolMemberPattern`) reads `<name>-NN.mp3` as a take of `<name>` (issue
 * #1173). So a take lists as its base — `niklas.mp3` and `niklas-01.mp3` are
 * one entry, and a pack that records only `adam-01.mp3` lists `adam` — and
 * listing `niklas-01` instead would offer a base no voice's bare `niklas`
 * clips answer to. The fold is `@iracedeck/callout-script`'s
 * `stripTakeSuffix`, the same two-digit rule, so a name that merely ends in
 * digits (`r2d2`, `abc-1`) is left as it is.
 */
export function scanDriverNames(manifest: AudioAssetsManifest): string[] {
  const names = new Set<string>();

  for (const clip of manifest.clips) {
    if (!clip.startsWith("voice/")) continue;

    const segments = clip.split("/");

    if (segments.length === 4 && segments[2] === "names") {
      const file = segments[3];
      const name = stripTakeSuffix(file.endsWith(".mp3") ? file.slice(0, -".mp3".length) : file);

      if (name.length > 0) names.add(name);
    }
  }

  return Array.from(names).sort();
}

/**
 * The clip that speaks `name` in `voice`, for the players that address a
 * driver name by PATH rather than as a pool — the radio check and the Race
 * Engineer Test button (issue #1173). The bare `names/<name>.mp3` when the
 * voice has one, otherwise its lowest take (`names/<name>-01.mp3`) — the
 * same `stripTakeSuffix` fold {@link scanDriverNames} lists by, so every
 * name the list offers is heard in a pack that records names only as takes.
 * `null` when the voice has no clip for the name at all.
 */
export function driverNameClip(manifest: AudioAssetsManifest, voice: string, name: string): string | null {
  const dir = `voice/${voice}/names/`;
  const bare = `${dir}${name}.mp3`;
  let lowestTake: string | null = null;

  for (const clip of manifest.clips) {
    if (clip === bare) return bare;

    if (!clip.startsWith(dir) || !clip.endsWith(".mp3")) continue;

    const file = clip.slice(dir.length, -".mp3".length);

    if (file.includes("/") || stripTakeSuffix(file) !== name) continue;

    if (lowestTake === null || clip < lowestTake) lowestTake = clip;
  }

  return lowestTake;
}

/**
 * Union the compiled-in manifest with clip lists contributed by installed voice
 * packs (issue #1034).
 *
 * `ambientLoop` and `ticks` always come from the built-in manifest: those assets
 * ship with the plugin. Since #1064 the radio frame itself is PACK-DEFINED —
 * the active voice's `callouts.json` says what its frames play, and a pack's
 * own beep rides the SFX channel exactly as the built-in tick does — so the
 * only thing pinned here is `ambientLoop`, the one asset a frame's `ambient`
 * steps drive by reference rather than by path; `ticks` stays for the
 * legacy sequences that spell the built-in tick inline (gone with #1065).
 *
 * The result is de-duplicated and sorted, so an identical set of packs produces
 * an identical manifest whatever order they were scanned in — which is what
 * lets a reload be compared against the previous one.
 */
export function mergeManifests(
  builtIn: AudioAssetsManifest,
  fragments: readonly (readonly string[])[],
): AudioAssetsManifest {
  if (fragments.length === 0) return builtIn;

  const clips = new Set(builtIn.clips);

  for (const fragment of fragments) {
    for (const clip of fragment) clips.add(clip);
  }

  return { ...builtIn, clips: Array.from(clips).sort() };
}
