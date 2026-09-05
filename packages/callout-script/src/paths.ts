/** The script's file name inside a voice's tree. */
export const CALLOUT_SCRIPT_FILE = "callouts.json";

/**
 * Where a voice's script lives inside ANY audio root — the plugin's bundled
 * `assets/audio`, or an installed pack's folder: `voice/<voice-id>/callouts.json`.
 *
 * POSIX-separated, relative to the root; join it onto the root with the
 * caller's path module. It sits inside the voice tree so it rides every path a
 * voice already travels — the build copy, the packer, the installer's seed and
 * the scanner — with no extra wiring.
 *
 * The id is used verbatim: callers hand it an id that already passed the
 * voice-pack manifest's kebab-case rule, so nothing here re-validates it.
 */
export function calloutScriptPath(voiceId: string): string {
  return `voice/${voiceId}/${CALLOUT_SCRIPT_FILE}`;
}
