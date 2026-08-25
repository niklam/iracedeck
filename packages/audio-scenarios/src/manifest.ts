/**
 * Audio-asset manifest types + helpers, extracted to break the
 * interpreter ↔ validation circular import. Both modules consume these
 * symbols, so they live in a leaf module that depends on neither.
 */

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
 */
export function referenceVoice(manifest: AudioAssetsManifest): string | null {
  const voices = scanRaceEngineerVoices(manifest);

  if (voices.length === 0) return null;

  return voices.includes("default") ? "default" : voices[0];
}

/**
 * Sorted array of available driver-name keys (the names the engineer can
 * address the user as) derived from `voice/<voice>/names/<name>.mp3`
 * paths. The set is the union across voices — a name only present for one
 * voice still shows up; runtime playback skips gracefully when the active
 * voice has no clip for the chosen name.
 */
export function scanDriverNames(manifest: AudioAssetsManifest): string[] {
  const names = new Set<string>();

  for (const clip of manifest.clips) {
    if (!clip.startsWith("voice/")) continue;

    const segments = clip.split("/");

    if (segments.length === 4 && segments[2] === "names") {
      const file = segments[3];
      const name = file.endsWith(".mp3") ? file.slice(0, -".mp3".length) : file;

      if (name.length > 0) names.add(name);
    }
  }

  return Array.from(names).sort();
}

/**
 * Union the compiled-in manifest with clip lists contributed by installed voice
 * packs (issue #1034).
 *
 * `ambientLoop` and `ticks` always come from the built-in manifest: those assets
 * ship with the plugin, and a pack must never be able to redefine the radio
 * frame every callout is wrapped in.
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
