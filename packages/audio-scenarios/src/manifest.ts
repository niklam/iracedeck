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
