/**
 * Race Engineer voice plumbing: the one router every plugin-played Voice line
 * goes through ({@link playVoiceLine}), the key-press acknowledgment
 * ({@link playKeyAck}), the master toggle acknowledgment, the JSON-list
 * reader, and the track-call opt-ins (corner names and sector starts) behind
 * the Pit Crew Corner Names key.
 *
 * Extracted from Pit Crew for issue #782 so the Audio Controls dial's
 * Mute/Unmute and the Pit Crew toggle keys share one pathway (the same move
 * #590 made for the volume steppers). The master gates themselves moved on to
 * `feature-gates.ts` (issue #1007), which owns the side effects of a gate
 * change so a settings-window checkbox behaves exactly like a deck key; this
 * module keeps the voice plumbing those acknowledgments ride on.
 *
 * Since issue #1698 every line the plugin plays by path — the key acks, the
 * Race Engineer on/off acks, the voice Test and the radio check — goes through
 * {@link playVoiceLine}, which hands it to the scenario engine's scheduler
 * while the engine is up. A line played straight onto the Voice channel
 * beside the engine cut a callout and took the channel's one completion
 * callback from it, so the callout's fire never ended and the engineer went
 * quiet until the master was switched off. {@link playVoiceSequence}, the
 * direct play, is left as the fallback for an engine that is not initialised;
 * Pit Crew re-exports it for test back-compat.
 */
import {
  getScenarioEngine,
  isAudioScenariosInitialized,
  type PlayClipsResult,
  type PlayClipsWhenBusy,
  WEIGHT,
} from "@iracedeck/audio-scenarios";
import { AudioBus, AudioChannel, getAudio } from "@iracedeck/audio-service";
import type { ILogger } from "@iracedeck/logger";
import {
  getGlobalSettings,
  isCalloutEnabled,
  resolveActiveRaceEngineerVoice,
  setCalloutEnabled,
  setCalloutsEnabled,
} from "@iracedeck/settings";

import { claimRaceEngineerBypass, isRaceEngineerEnabled, readRaceEngineerVolume } from "./audio-volume.js";

/**
 * Read the per-callout opt-in for the Race Engineer toggle acknowledgment
 * (issue #554). Defaults to enabled — only an explicit `false` opts out, so
 * a fresh install (no persisted setting) and existing users get the ack
 * without editing settings. Read live on every toggle so the PI checkbox
 * takes effect immediately without re-registering anything.
 */
export function isToggleAckEnabled(): boolean {
  return isCalloutEnabled("calloutEnabledToggleRaceEngineer");
}

/**
 * Read a JSON-array global-settings value (used for the runtime-pushed
 * voice + driver-name lists). Returns an empty array if missing or
 * malformed — callers treat that as "list not available yet" and skip
 * the dependent path rather than throw.
 */
export function readJsonStringArray(key: string): string[] {
  const raw = getGlobalSettings()[key];

  if (typeof raw !== "string" || raw.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Chain-play a sequence of clip paths on `AudioChannel.Voice`, beside the
 * scenario engine — {@link playVoiceLine}'s fallback for an engine that is not
 * initialised, and nothing else's (issue #1698): played while the engine is up
 * it would cut a callout and take its completion callback. Registers
 * the next-step `onChannelComplete` before each `playOnChannel` so the
 * sequence keeps stepping naturally as each clip ends. A failed
 * `playOnChannel` (e.g. clip missing — likely until the user has run
 * `pnpm --filter @iracedeck/audio-assets generate`) silently breaks the
 * chain at that step rather than throwing; the user just hears the
 * earlier clips.
 */
/** @internal Exported for testing the chain-completion + failure paths. */
export function playVoiceSequence(paths: readonly string[], onComplete?: () => void): boolean {
  if (paths.length === 0) return false;

  let idx = 0;
  let finished = false;

  // Idempotent terminal — guards against `onComplete` firing twice (once via
  // the failure path below and again if a stale `playStep` registration is
  // re-entered by a later, unrelated Voice completion).
  const finish = (): void => {
    if (finished) return;

    finished = true;
    onComplete?.();
  };

  const playStep = (): void => {
    // A previous step may have already finished (e.g. mid-chain playback
    // failure). The completion callback registered before that failure is
    // still live in `audio-service`; if any later Voice clip plays through
    // the engine, it will re-fire `playStep`. Bail out so we don't try to
    // resume an abandoned sequence.
    if (finished) return;

    if (idx >= paths.length) {
      finish();

      return;
    }

    const path = paths[idx++];

    // Always register the next-step callback — when `idx` has reached the
    // end on the next invocation, `playStep` will fire `onComplete`. Without
    // this on the last clip, the chain ends silently and callers can't tell
    // the preview is over (used by the RE Volume Test in-flight tracking).
    getAudio().onChannelComplete(AudioChannel.Voice, playStep);

    const ok = getAudio().playOnChannel(AudioChannel.Voice, path);

    // If the clip failed to start (e.g. file missing — likely until the
    // user has run `pnpm --filter @iracedeck/audio-assets generate`), the
    // native layer never fires the channel-complete callback, so the chain
    // would otherwise hang forever and `onComplete` would never run. Fire
    // it synchronously so callers (and any in-flight flag they're tracking)
    // can clean up.
    if (!ok) {
      finish();
    }
  };

  playStep();

  return true;
}

/** How {@link playVoiceLine} plays a line on a Voice bus that is not free, and what it runs when the line is over. */
export type VoiceLineOptions = { whenBusy: PlayClipsWhenBusy; onComplete?: () => void };

/**
 * Play a plugin's own Voice line — clips by path, outside any script — through
 * the one route every such line takes (issue #1698).
 *
 * With the scenario engine initialised the line goes to its scheduler as a
 * clip fire at `WEIGHT.NORMAL` (`playClips`), so it is arbitrated with the
 * callouts instead of playing over them; `whenBusy` says what happens on a bus
 * that is not free (`"skip"`: nothing; `"interrupt"`: it cuts what is not
 * heavier than NORMAL, and a cut callout comes back after it), and the answer
 * is the engine's. `id` names the fire in the log and must name no registered
 * contract — use a namespace no contract uses (`toggle.<clip>`).
 *
 * With the engine not initialised there is nothing to arbitrate with, so the
 * line plays straight onto the Voice channel ({@link playVoiceSequence}),
 * cutting whatever was there, and the answer is always `"playing"`; a clip
 * that fails to start ends the line at once there too.
 *
 * `onComplete` runs once when the line is over, however it ends — finished,
 * cut, stopped, or every clip failing, possibly before this returns — and
 * never when the answer is `"bus-busy"`, where nothing started: a caller that
 * set an in-flight flag clears it on that answer itself.
 *
 * Throws on an empty `paths` in both modes, as `playClips` does: there is no
 * line, and either answer would misreport it.
 */
export function playVoiceLine(id: string, paths: readonly string[], options: VoiceLineOptions): PlayClipsResult {
  if (paths.length === 0) throw new Error(`playVoiceLine: "${id}" has no clips to play`);

  if (!isAudioScenariosInitialized()) {
    playVoiceSequence(paths, options.onComplete);

    return "playing";
  }

  return getScenarioEngine().playClips(id, paths, { weight: WEIGHT.NORMAL, ...options });
}

/**
 * The fire id an acknowledgment clip plays under: `toggle.<clip>`, a namespace
 * no contract uses, so `playClips` never takes the line for a callout.
 */
function ackFireId(clip: string): string {
  return `toggle.${clip}`;
}

/** The active voice's `toggle/<clip>.mp3`, or `null` when no voice is available yet. */
function ackClipPath(clip: string): string | null {
  const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

  return voice ? `voice/${voice}/toggle/${clip}.mp3` : null;
}

/**
 * Speak a key press's acknowledgment — `voice/<active voice>/toggle/<clip>.mp3`
 * — the one entry point every Pit Crew key ack plays through (issue #1698).
 *
 * The driver pressed the key, so the answer comes now: the clip plays with
 * `whenBusy: "interrupt"`, cutting a callout that is not heavier than NORMAL
 * (the callout comes back after it) and a previous ack still playing, so two
 * quick presses speak only the newer state. A heavier call holding the radio
 * — a safety-band line, the spotter's focus — keeps it, and the ack is left
 * out with a debug line: the toggle has already applied, and the key icon
 * shows the new state. Skipped with a debug line when no voice is available.
 *
 * The caller owns the gates (the Race Engineer master, the ack's opt-in); this
 * only plays.
 */
export function playKeyAck(clip: string, logger: ILogger): void {
  const path = ackClipPath(clip);

  if (path === null) {
    logger.debug(`Key ack ${clip} skipped — no voice available`);

    return;
  }

  if (playVoiceLine(ackFireId(clip), [path], { whenBusy: "interrupt" }) === "bus-busy") {
    logger.debug(`Key ack ${clip} skipped — the engineer holds the radio for a heavier call`);
  }
}

/**
 * Play a Race Engineer master toggle acknowledgment (`going-silent-01` /
 * `resuming-01`) through {@link playVoiceLine}, with `whenBusy: "interrupt"`
 * as every key ack (issue #1698): "going silent" finds a free bus after the
 * gate's `stopAll`, "resuming" cuts a callout that arrived first.
 *
 * Raises the `toggle` bypass so `applyRaceEngineerAudio` keeps Voice audible
 * regardless of the master gate, forces the Voice bus to the current
 * `raceEngineerVolume`, and hangs the bypass's release on the line's
 * `onComplete`, which clears it and re-applies audio when the line is over —
 * finished, cut, stopped, or its clip failing to start. On `"bus-busy"` the
 * line never started, so `onComplete` will not run and the release runs here.
 * The release is a claim's (`claimRaceEngineerBypass`): an older ack's
 * completion, arriving inside this one's `playClips` because this one cut it,
 * finds its claim stale and leaves the flag this ack raised alone.
 *
 * Skipped silently when no voice is available (fresh install before
 * the voice list has been pushed); the toggle itself still applies so
 * the user's gate state can never desync from the audio state.
 */
export function playToggleAck(clipName: "going-silent-01" | "resuming-01", logger: ILogger): void {
  const path = ackClipPath(clipName);

  if (path === null) {
    logger.debug(`Toggle ack ${clipName} skipped — no voice available`);

    return;
  }

  const release = claimRaceEngineerBypass("toggle");
  // Force Voice to the slider value so the ack is audible regardless of
  // the master gate. Mirrors how the Voice Test bypasses the gate.
  getAudio().setBusVolume(AudioBus.Voice, readRaceEngineerVolume() / 100);

  let result: PlayClipsResult;

  try {
    result = playVoiceLine(ackFireId(clipName), [path], { whenBusy: "interrupt", onComplete: release });
  } catch (error) {
    // Nothing started, so nothing will run the release: drop the bypass here
    // rather than leave Voice held open past the master gate.
    release();
    throw error;
  }

  if (result === "bus-busy") {
    release();
    logger.debug(`Toggle ack ${clipName} skipped — the engineer holds the radio for a heavier call`);
  }
}

/**
 * Whether the corner-name callouts (issue #888) are enabled. Reads the SAME
 * per-callout opt-in the PI checkbox writes (`calloutEnabledCornerNames`), so
 * the Pit Crew Corner Names key and the checkbox mirror one value. Defaults
 * to enabled — only an explicit `false` opts out (the callout family's
 * natural baseline).
 */
export function isCornerNamesEnabled(): boolean {
  return isCalloutEnabled("calloutEnabledCornerNames");
}

/**
 * Whether the sector-start callouts (issue #1573) are enabled. Reads the
 * opt-in the Settings window checkbox writes (`calloutEnabledSectorStarts`),
 * which the Pit Crew Corner Names key also flips since #1699. Same
 * live-read, only-an-explicit-false-opts-out shape as
 * {@link isCornerNamesEnabled}.
 */
export function isSectorStartsEnabled(): boolean {
  return isCalloutEnabled("calloutEnabledSectorStarts");
}

/**
 * Per-callout opt-in for the Corner Names key's toggle acknowledgment (issue
 * #897). Since #1699 it gates the ack of every target the key toggles —
 * corners, sectors and both. Same defaults-to-enabled live-read shape as
 * {@link isToggleAckEnabled}.
 */
export function isCornerNamesToggleAckEnabled(): boolean {
  return isCalloutEnabled("calloutEnabledToggleCornerNames");
}

/**
 * What one press of the Pit Crew Corner Names key toggles (#1699): the
 * corner-name calls, the sector-start calls, or both together.
 */
export type TrackCallTarget = "corners" | "sectors" | "both";

/**
 * The new state of each track-call opt-in a {@link toggleTrackCallouts} call
 * touched. A key it did not touch is absent: `corners` only for the
 * `corners` and `both` targets, `sectors` only for `sectors` and `both`.
 */
export interface TrackCallsToggleResult {
  corners?: boolean;
  sectors?: boolean;
}

/** One whole-phrase toggle ack clip in the `toggle` group, by target and resulting state. */
export type TrackCallsAckClip = `${"corner-names" | "sector-starts" | "track-calls"}-${"on" | "off"}-01`;

const ACK_CLIP_STEM: Record<TrackCallTarget, "corner-names" | "sector-starts" | "track-calls"> = {
  corners: "corner-names",
  sectors: "sector-starts",
  both: "track-calls",
};

/**
 * Flip the track-call opt-ins one press of the Pit Crew Corner Names key
 * names (issues #897, #1699) and return the new state of each one touched.
 *
 * - `corners` flips `calloutEnabledCornerNames`.
 * - `sectors` flips `calloutEnabledSectorStarts`.
 * - `both` turns both off when either is on, and both on when both are off,
 *   written in ONE settings update so the listeners see a single change. From
 *   a mixed state the result is silence: the key's aggregate state reads "on"
 *   whenever either is on, so a press on a key that shows ON always gives OFF.
 *
 * The scenarios read their opt-in live on every event, so persisting the
 * flip is the whole toggle — nothing to stop or re-register, and an
 * in-flight clip plays through (the #554 opt-in semantics).
 *
 * The acknowledgment states the RESULTING state (a "both" press from a mixed
 * state speaks the off clip). It plays only when the Race Engineer master
 * gate and the `calloutEnabledToggleCornerNames` opt-in are on: unlike the
 * master toggle this flip never mutes the Voice bus, so no in-flight bypass
 * or bus-volume force is needed. Master off means a silent flip (the
 * engineer is off the air). The toggle applies whether or not the ack plays.
 */
export function toggleTrackCallouts(target: TrackCallTarget, logger: ILogger): TrackCallsToggleResult {
  let result: TrackCallsToggleResult;
  let on: boolean;

  switch (target) {
    case "corners": {
      on = !isCornerNamesEnabled();
      logger.info(`Corner name callouts ${on ? "enabled" : "disabled"}`);
      setCalloutEnabled("calloutEnabledCornerNames", on);
      result = { corners: on };
      break;
    }

    case "sectors": {
      on = !isSectorStartsEnabled();
      logger.info(`Sector callouts ${on ? "enabled" : "disabled"}`);
      setCalloutEnabled("calloutEnabledSectorStarts", on);
      result = { sectors: on };
      break;
    }

    case "both": {
      on = !isCornerNamesEnabled() && !isSectorStartsEnabled();
      logger.info(`Corner and sector callouts ${on ? "enabled" : "disabled"}`);
      setCalloutsEnabled(["calloutEnabledCornerNames", "calloutEnabledSectorStarts"], on);
      result = { corners: on, sectors: on };
      break;
    }
  }

  if (isRaceEngineerEnabled() && isCornerNamesToggleAckEnabled()) {
    playTrackCallsAck(`${ACK_CLIP_STEM[target]}-${on ? "on" : "off"}-01`, logger);
  }

  return result;
}

/**
 * Play one Corner Names key acknowledgment (`voice/<voice>/toggle/<clip>.mp3`)
 * — the single call site for all six track-call ack clips (#1699). It plays
 * through {@link playKeyAck}, so it cuts in through the scheduler like every
 * key ack instead of playing over a callout (#1698), and is skipped with a
 * debug line when no voice is available. A pack without the clip plays nothing.
 */
export function playTrackCallsAck(clip: TrackCallsAckClip, logger: ILogger): void {
  playKeyAck(clip, logger);
}

/**
 * Flip the corner-name callout opt-in. Returns the NEW state.
 *
 * @deprecated — removed by #1699 T2; call `toggleTrackCallouts("corners", logger)`.
 */
export function toggleCornerNamesFeature(logger: ILogger): boolean {
  return toggleTrackCallouts("corners", logger).corners === true;
}
