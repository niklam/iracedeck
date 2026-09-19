/**
 * The path the plugin-played name lines address a driver name by (issue
 * #1173): the telemetry-connect radio check and the Race Engineer Test button
 * both open with the name, and both play it by PATH — no script entry reaches
 * them, so the engine's pool rule never gets a say.
 *
 * A path spelled `names/<name>.mp3` misses a pack that records names only as
 * takes (`names/<name>-01.mp3`), and since #1173 the name list offers only
 * bases, so that would silence both lines in such a pack for every user. This
 * resolves the name against the engine's live manifest — the built-in clips
 * plus every installed pack — with {@link driverNameClip}.
 */
import { getScenarioEngine, isAudioScenariosInitialized } from "../../interpreter.js";
import { driverNameClip } from "../../manifest.js";

/**
 * The clip to play for `name` in `voice`. Falls back to the bare
 * `voice/<voice>/names/<name>.mp3` when the engine is not initialized or the
 * voice has no clip for the name — the path these players always used, which
 * then fails to start and ends the sequence exactly as it did before.
 */
export function driverNameClipPath(voice: string, name: string): string {
  const bare = `voice/${voice}/names/${name}.mp3`;

  if (!isAudioScenariosInitialized()) return bare;

  return driverNameClip(getScenarioEngine().currentManifest(), voice, name) ?? bare;
}
