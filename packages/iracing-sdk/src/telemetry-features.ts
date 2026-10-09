/**
 * iRacing SDK car-capability detection.
 *
 * iRacing only exposes a driver-control (`dc*`) telemetry field when the car actually
 * has that control, so the *presence* of a field — not its value — signals whether the
 * car has the feature. These pure helpers wrap that field-presence check so consumers
 * (actions, audio-scenarios, tests) can ask "does this car have X?" consistently.
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-native";

import { isReplayOnlySession } from "./session-utils.js";
import { hasFlag } from "./utils.js";

/**
 * Check whether the current car has a pit speed limiter.
 *
 * iRacing only exposes `dcPitSpeedLimiterToggle` on cars equipped with a limiter, so
 * the field's presence is the capability signal (its boolean value is the on/off state).
 *
 * @param t - The latest telemetry snapshot, or null when no telemetry is available
 * @returns true if the car has a pit limiter, false otherwise (including for null)
 *
 * @example
 * if (!hasPitLimiter(getLatestTelemetry())) {
 *     // skip pit-limiter callouts / grey out the limiter button
 * }
 */
export function hasPitLimiter(t: TelemetryData | null): boolean {
  return t?.dcPitSpeedLimiterToggle !== undefined;
}

/**
 * Check whether the current car has a tear-off visor (typically open-cockpit cars).
 *
 * iRacing only exposes `dcTearOffVisor` on cars with a visor. Visor and wipers are
 * mutually exclusive per car, so {@link hasVisor} and {@link hasWipers} are complementary.
 *
 * @param t - The latest telemetry snapshot, or null when no telemetry is available
 * @returns true if the car has a tear-off visor, false otherwise (including for null)
 */
export function hasVisor(t: TelemetryData | null): boolean {
  return t?.dcTearOffVisor !== undefined;
}

/**
 * Check whether the current car has windshield wipers (typically closed-cockpit cars).
 *
 * iRacing exposes either `dcToggleWindshieldWipers` (on/off) or `dcTriggerWindshieldWipers`
 * (momentary) on cars with wipers; presence of either signals the capability. Wipers and
 * a tear-off visor are mutually exclusive per car, so {@link hasWipers} and {@link hasVisor}
 * are complementary.
 *
 * @param t - The latest telemetry snapshot, or null when no telemetry is available
 * @returns true if the car has windshield wipers, false otherwise (including for null)
 */
export function hasWipers(t: TelemetryData | null): boolean {
  return t?.dcToggleWindshieldWipers !== undefined || t?.dcTriggerWindshieldWipers !== undefined;
}

/**
 * The finest unit the current car's pit crew can change tires in:
 * `"corner"` (any single tire), `"side"` (left or right pair) or `"all"`
 * (all four at once).
 */
export type TireChangeGranularity = "corner" | "side" | "all";

/**
 * Detect the current car's tire-change granularity (#954).
 *
 * iRacing publishes only the `dp*TireChange` fields that match what the car's
 * pit crew can do: the four corner fields (`dpLFTireChange` …), the two side
 * fields (`dpLTireChange` / `dpRTireChange`) or the single `dpTireChange`. The
 * fields' presence is the capability; their values are never read.
 *
 * The FINEST level any present field implies wins, so an unexpected mix (a
 * corner field beside `dpTireChange`, say) resolves to the finer level: that
 * way a wrong reading only fails to expand a request, which is what the sim
 * received before, rather than changing tires the user did not ask for.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns the granularity, or null when disconnected or when the car publishes none of the fields
 */
export function getTireChangeGranularity(t: TelemetryData | null | undefined): TireChangeGranularity | null {
  if (!t) return null;

  if (
    t.dpLFTireChange !== undefined ||
    t.dpRFTireChange !== undefined ||
    t.dpLRTireChange !== undefined ||
    t.dpRRTireChange !== undefined
  ) {
    return "corner";
  }

  if (t.dpLTireChange !== undefined || t.dpRTireChange !== undefined) return "side";

  if (t.dpTireChange !== undefined) return "all";

  return null;
}

/**
 * Whether the session is in a PRE-GREEN phase — the grid / warmup / formation
 * (parade) lap before the green flag, plus `Invalid` (telemetry settling /
 * unknown). During these phases neither iRacing's live-standings position
 * fields (`PlayerCarPosition` / `CarIdxPosition`) nor the lap-distance-derived
 * running order are meaningful: on a rolling-start formation lap the whole
 * field reads `0` until cars cross the start/finish line. Callers use this to
 * suppress position-change callouts and to show the qualifying grid slot
 * instead of a churning/zero live position (issue #647).
 *
 * Defined as the EXPLICIT set of pre-racing states, NOT `!== Racing`:
 *   - a missing `SessionState` yields `false` (back-compat — callers/tests that
 *     don't supply it keep their prior behavior), and
 *   - the post-racing states (`Checkered` / `CoolDown`) are not pre-green, so
 *     legitimate late-race passes are never suppressed.
 *
 * NOTE: this is distinct from the translator's fresh-connect race-start gate,
 * which deliberately treats `Invalid` as "telemetry still settling, keep
 * waiting" rather than pre-green (issue #604) — that gate is a separate 3-state
 * predicate and intentionally does not use this helper.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true during Invalid / GetInCar / Warmup / ParadeLaps; false otherwise
 */
export function isPreGreen(t: TelemetryData | null | undefined): boolean {
  const state = t?.SessionState;

  return (
    state === SessionState.Invalid ||
    state === SessionState.GetInCar ||
    state === SessionState.Warmup ||
    state === SessionState.ParadeLaps
  );
}

/**
 * Whether the driver is genuinely live in their own car on track — i.e. driving,
 * not watching a replay, spectating, or sitting in the session menu / on the
 * grid out of the car (where iRacing reports `IsReplayPlaying: true` and/or
 * `IsOnTrack: false`). Mirrors the translator's `driver.firstOnTrack` gate.
 *
 * Race-engineer callouts that only make sense to a driver in the car (start
 * lights, the race-formation flags) gate on this so they stay silent while the
 * user is out of the car at the grid / in a replay.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true only when `IsOnTrack` is true and `IsReplayPlaying` is not true
 */
export function isLiveOnTrack(t: TelemetryData | null | undefined): boolean {
  return t?.IsOnTrack === true && t?.IsReplayPlaying !== true;
}

/**
 * The replay frame the moment on screen has — the ONE position read every
 * replay-marker and lap-record consumer measures against (#1162, #1203).
 *
 * In a replay (`IsReplayPlaying === true`, paused included) it is
 * `ReplayFrameNum`, the absolute position over the whole recording. While
 * driving, `ReplayFrameNum` reads a constant 0 and the frame the recording is
 * at is its current length, `ReplayFrameNumEnd` — which grows at 60 frames per
 * second of session time. Both are frames of the same absolute numbering, so a
 * marker set from the car and a jump made from the replay agree.
 *
 * Returns `null` when the field the mode needs is missing or not a finite
 * number — a consumer then does nothing, rather than jumping to frame 0.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 */
export function resolveReplayFrame(t: TelemetryData | null | undefined): number | null {
  if (!t) return null;

  const frame = t.IsReplayPlaying === true ? t.ReplayFrameNum : t.ReplayFrameNumEnd;

  return typeof frame === "number" && Number.isFinite(frame) ? frame : null;
}

/**
 * How long (ms) `IsReplayPlaying` must read false before the replay counts as
 * left for the car. For roughly 300 ms after every `setPlayPosition` iRacing
 * reports it false (measured 2026-10-04, #1324), so a consumer reading the raw
 * flag per tick took every seek for a trip to live: the translator ran its
 * live diffs over replay telemetry, Session Info flashed an incident and the
 * replay surfaces refused a press as "from the car". The 1 s is #1230's
 * measured margin over the blip, moved here from Replay Markers.
 */
export const REPLAY_EXIT_GRACE_MS = 1_000;

/**
 * Whether a replay is on screen and the frame it shows, debounced (#1324). The
 * one instance lives on `SDKController`, stepped by {@link nextReplayState}
 * on every notified tick and read through {@link replayStateAt}, so the
 * translator, the keys and the dials cannot disagree about it.
 *
 * `inReplay` and `frame` are the answer as of the time the state was last
 * evaluated at; the other fields are what a later evaluation needs, since the
 * grace expires between ticks too (a press lands at any time).
 */
export interface ReplayState {
  /**
   * Whether a replay is on screen: the tick read `IsReplayPlaying === true`,
   * the last tick that did is less than {@link REPLAY_EXIT_GRACE_MS} ago, or
   * the session is a saved replay. Entering a replay counts at once.
   */
  readonly inReplay: boolean;
  /**
   * The frame on screen: `ReplayFrameNum` on a replay tick, the last frame a
   * replay tick showed through the grace, and `ReplayFrameNumEnd` live, as in
   * {@link resolveReplayFrame}. Null when the field is missing or not finite.
   */
  readonly frame: number | null;
  /** Whether the loaded session is a saved replay (`WeekendInfo.SimMode === "replay"`), never live. */
  readonly replayOnlySession: boolean;
  /** The last tick's raw `IsReplayPlaying` read. */
  readonly tickReplayPlaying: boolean;
  /**
   * The last tick's own frame: `ReplayFrameNum` while the flag is true or the
   * session is a saved replay, `ReplayFrameNumEnd` otherwise. What `frame`
   * falls back to once the grace has run out.
   */
  readonly tickFrame: number | null;
  /** When the last tick that read `IsReplayPlaying === true` was, or null since the replay was left (or never seen). */
  readonly replaySeenAt: number | null;
  /** The frame that tick showed — the one held through the grace. */
  readonly replaySeenFrame: number | null;
  /**
   * Set by {@link replayLeftForLive} until the first tick that has left the
   * replay. iRacing applies `goToEnd` a tick or two later, so the ticks in
   * between still read as a replay; recording them would revive the grace the
   * exit just dropped.
   */
  readonly liveExitPending: boolean;
}

/** The state before any tick: live, no frame, nothing sighted. */
export function initialReplayState(): ReplayState {
  return {
    inReplay: false,
    frame: null,
    replayOnlySession: false,
    tickReplayPlaying: false,
    tickFrame: null,
    replaySeenAt: null,
    replaySeenFrame: null,
    liveExitPending: false,
  };
}

/** `value` as a finite frame number, else null. */
function finiteFrame(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether the last replay sighting is still inside the grace at `nowMs`. */
function withinReplayGrace(state: ReplayState, nowMs: number): boolean {
  return state.replaySeenAt !== null && nowMs - state.replaySeenAt < REPLAY_EXIT_GRACE_MS;
}

/**
 * The state's `inReplay` and `frame` re-evaluated at `nowMs`: the grace runs
 * on wall time, so a read between ticks (a key press, a dial turn) sees it
 * expire without waiting for the next tick. Pure; the sighting fields are
 * untouched, and the same object comes back when nothing changed.
 *
 * In a saved replay past the grace the frame is the tick's `ReplayFrameNum`
 * (the `tickFrame` {@link nextReplayState} stored for it); whether iRacing
 * keeps that field meaningful while the flag reads false there is
 * unverified against the sim.
 */
export function replayStateAt(state: ReplayState, nowMs: number): ReplayState {
  const inReplay = state.tickReplayPlaying || withinReplayGrace(state, nowMs) || state.replayOnlySession;
  const frame = !state.tickReplayPlaying && withinReplayGrace(state, nowMs) ? state.replaySeenFrame : state.tickFrame;

  return inReplay === state.inReplay && frame === state.frame ? state : { ...state, inReplay, frame };
}

/**
 * The rule (#1324): the state after a tick. A tick is in a replay when it
 * reads `IsReplayPlaying === true`, when the last tick that did is less than
 * {@link REPLAY_EXIT_GRACE_MS} ago, or when the session is a saved replay. A
 * replay tick records the sighting the grace runs from (unless a live exit
 * is pending, see {@link replayLeftForLive}); a tick that has left the replay
 * drops it. `nowMs` is the tick's wall time, injectable for tests.
 */
export function nextReplayState(
  prev: ReplayState,
  telemetry: TelemetryData,
  sessionInfo: unknown,
  nowMs: number,
): ReplayState {
  const replayOnlySession = isReplayOnlySession(sessionInfo);
  const tickReplayPlaying = telemetry.IsReplayPlaying === true;
  const tickFrame = finiteFrame(
    tickReplayPlaying || replayOnlySession ? telemetry.ReplayFrameNum : telemetry.ReplayFrameNumEnd,
  );
  let { replaySeenAt, replaySeenFrame, liveExitPending } = prev;

  if (tickReplayPlaying && !liveExitPending) {
    replaySeenAt = nowMs;
    replaySeenFrame = tickFrame;
  }

  const stepped: ReplayState = {
    ...prev,
    replayOnlySession,
    tickReplayPlaying,
    tickFrame,
    replaySeenAt,
    replaySeenFrame,
    liveExitPending,
  };

  if (!tickReplayPlaying && !withinReplayGrace(stepped, nowMs) && !replayOnlySession) {
    // Left for the car: the grace has run out (or a live exit dropped it), so
    // the sighting goes, and any pending live exit has now happened.
    return replayStateAt({ ...stepped, replaySeenAt: null, replaySeenFrame: null, liveExitPending: false }, nowMs);
  }

  return replayStateAt(stepped, nowMs);
}

/**
 * The state after the plugin's own `goToEnd` was sent (#1230, #1324). In a
 * session that can go live the command leaves the replay for the car at once,
 * so the sighting is dropped and no grace follows: a false read straight
 * after it is the car, not the post-seek blip, and holding the old replay
 * frame would file a marker at that frame instead of the live edge. Until the
 * first tick that has left the replay, replay ticks are not recorded: they
 * are the ticks before iRacing applies the command. In a saved replay the same
 * command only seeks to the end of the file and the replay stays open, so the
 * state is returned as is. Call it only for a command that was actually sent.
 */
export function replayLeftForLive(state: ReplayState): ReplayState {
  if (state.replayOnlySession) return state;

  return {
    ...state,
    inReplay: state.tickReplayPlaying,
    frame: state.tickFrame,
    replaySeenAt: null,
    replaySeenFrame: null,
    liveExitPending: true,
  };
}

/**
 * Whether the session is in a POST-RACE phase — the checkered flag is out or the
 * field is in cool-down. The mirror image of {@link isPreGreen}: both are
 * defined as EXPLICIT state sets (not a `=== Racing` negation) so a missing
 * `SessionState` yields `false` (back-compat for callers/tests that don't supply
 * it), and only the genuinely-finished states match.
 *
 * Race-progression / formation callouts (the rolling-start "one pace lap to go",
 * "green's coming", crossed flags, ten/five-to-go) gate on `!isPostRace` so they
 * stay silent once the race is over — iRacing re-asserts some of the grid bits
 * (e.g. `OneLapToGreen`) during cool-down / next-session grid formation, which
 * otherwise re-fired "one pace lap to go" after the checkered (issue #657).
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true during Checkered / CoolDown; false otherwise
 */
export function isPostRace(t: TelemetryData | null | undefined): boolean {
  const state = t?.SessionState;

  return state === SessionState.Checkered || state === SessionState.CoolDown;
}

/**
 * Whether a driver-penalty flag — `Black` or `Disqualify` — is currently shown
 * to the player. This is THE definition of "the furled warning escalated into
 * an actual penalty" (issue #846): iRacing raises the real black flag by
 * clearing `Furled` and setting `Black` in the same transition, so the
 * translator's same-tick cleared-suppression and the audio layer's speak-time
 * gate must agree on what counts as a penalty — both call this predicate so
 * the two layers cannot silently diverge.
 *
 * Missing telemetry or a missing `SessionFlags` yields `false` (not escalated)
 * — don't punish missing data; a consumer that needs a different unknown-state
 * answer should check for null before calling.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true when the Black or Disqualify session-flag bit is set
 */
export function isPenaltyFlagActive(t: TelemetryData | null | undefined): boolean {
  return hasFlag(t?.SessionFlags, Flags.Black) || hasFlag(t?.SessionFlags, Flags.Disqualify);
}
