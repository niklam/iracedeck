/**
 * Maps "the active Race Engineer voice has no callout script" to a PI warning
 * record (issue #1064).
 *
 * Since #1064 a voice's callouts are data the voice pack ships
 * (`voice/<id>/callouts.json`), and a pack is never punished for what it does
 * not say: a voice with no script is a valid, clips-only voice whose callouts
 * are all skipped. Silence is the correct behaviour for that pack — and the
 * wrong experience for the user who picked the voice and now hears nothing,
 * with no log line in front of them to explain why. So the condition reaches
 * the Property Inspector, the one surface the user is already looking at.
 *
 * The decision is pure and takes its inputs by value — the resolved active
 * voice and the set of voices that DO have a script — so it lives beside the
 * voice-pack service without depending on it, and all three plugins share the
 * exact same wording. Same shape as `evaluateElevationWarning`.
 *
 * The message intentionally carries NO leading emoji — the `ird-warnings`
 * banner renders a level icon itself, so adding one here would double it.
 */
import type { PiWarning } from "./pi-warnings.js";

export const VOICE_SCRIPT_WARNING_ID = "voice-script-missing";

export interface VoiceScriptWarningInput {
  /**
   * The voice the Race Engineer would speak with right now — the output of
   * `resolveActiveRaceEngineerVoice`, `null` when no voice is available at
   * all. An empty string counts as no voice too: the setting's own "nothing
   * picked" value, and a banner naming voice `""` would explain nothing.
   */
  activeVoice: string | null;
  /** Every voice id the voice-pack service has a parsed script for. */
  scriptedVoices: ReadonlySet<string>;
}

/**
 * `null` when there is nothing to warn about: no active voice, or one with a
 * script. Otherwise the banner, naming the voice so a user with several packs
 * installed knows which one to reinstall.
 */
export function evaluateVoiceScriptWarning(input: VoiceScriptWarningInput): PiWarning | null {
  const { activeVoice, scriptedVoices } = input;

  if (activeVoice === null || activeVoice === "") return null;

  if (scriptedVoices.has(activeVoice)) return null;

  return { id: VOICE_SCRIPT_WARNING_ID, level: "warning", message: voiceScriptMissingMessage(activeVoice) };
}

/**
 * Two remedies, in the order a user should try them: the script travels
 * inside the pack, so a reinstall is what restores it (a pack built for the
 * pre-#1064 clips-only format never had one, and its author has to ship an
 * update); switching voices is the immediate way to get the engineer talking
 * again. "Race Engineer Voice" is the label of the dropdown in the settings
 * window, so the sentence names the control rather than describing it.
 */
function voiceScriptMissingMessage(voice: string): string {
  return (
    `The Race Engineer voice "${voice}" has no callout script, so it will stay silent. ` +
    "Reinstall the voice pack, or pick another voice under Race Engineer Voice."
  );
}
