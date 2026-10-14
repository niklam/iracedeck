/**
 * What the replay recorders share: which ticks are live enough to record
 * from, and the session identity a recorded moment carries.
 *
 * A replay recorder is a diff that notes a moment of the live session — a
 * car's lap start (`replay-laps.ts`, #1203), the green flag
 * (`replay-greens.ts`, #1354), a session's start (`replay-sessions.ts`) or an
 * incident (`replay-incidents.ts`, both #1426) — with the replay frame it
 * happened at, for @iracedeck/replay-store's per-session file. Every one of
 * them asks the question here rather than answering it itself: two records
 * that disagreed about which ticks are live would put a frame in one section
 * that another calls unobservable.
 *
 * There are two classes of tick, and so two resolvers.
 *
 * **In the car** ({@link resolveReplayRecordTick}): a tick is eligible when it
 * is not in a replay — the translator's `inReplay`, the controller's debounced
 * replay state (#1324): false only once `IsReplayPlaying` has read false for
 * the exit grace, and never in a saved replay (#604's `SimMode` — a `.rpy` has
 * nothing live in it), so a seek's blip tick is not eligible either —
 * `SessionNum >= 0`, and a frame is readable. Under that gate
 * `resolveReplayFrame` reads `ReplayFrameNumEnd`, the live frame, which a
 * recorder stores raw (#1162: no lag correction). The lap, green and incident
 * recorders use this one alone: they read per-car arrays, flags and counters
 * whose behaviour out of the car is its own question (`replay-laps.ts`).
 *
 * **In the car, or out of it at the live edge of a live session**
 * ({@link resolveReplayLiveTick}, #1426): the session-start recorder needs only
 * the session's identity, its clock and a frame, and no per-car array, so it
 * may also read the in-session replay while the cursor sits at the newest
 * frame. Out of the car `ReplayFrameNumEnd` counts the frames from the cursor
 * to the end of the tape (measured over ten snapshots, #1426: 1 at the live
 * edge, 1201 at 21 s back, tens of thousands further back), so the live frame
 * is `ReplayFrameNum + ReplayFrameNumEnd`, and a cursor within
 * {@link LIVE_EDGE_MAX_FRAMES} of the end is at the edge. A replay scrubbed
 * back is not live and nothing is read from it. The tick's own raw
 * `IsReplayPlaying` must read true: at the edge it does, and during a slow
 * seek it reads false beside `ReplayFrameNum` 0 and `SessionNum` −1, so the
 * debounced state only picks which case applies and never vouches for a tick
 * by itself.
 *
 * What a recorder does with an ineligible tick is its own business, and the
 * shape is the same for each: mark itself unseeded (or break its run), so the
 * first eligible tick after it re-seeds every baseline without emitting. That
 * is also why a recorder runs BEFORE the translator's replay guard — the
 * guard's early return would hide exactly the ticks it has to notice it
 * cannot see, and the session-start recorder records from some of them.
 *
 * A recorder that needs more of a tick than this (the lap record needs
 * `CarIdxLapCompleted`) adds its own condition on top; it never loosens this
 * one.
 */
import { resolveReplayFrame, type TelemetryData } from "@iracedeck/iracing-sdk";

/** The identity and frame of an eligible tick — see {@link resolveReplayRecordTick} and {@link resolveReplayLiveTick}. */
export type ReplayRecordTick = {
  sessionNum: number;
  /**
   * `SessionUniqueID`, which is on every live tick; a build without it reads 0
   * on every tick, so the pair still keys one record per `SessionNum`.
   */
  sessionUniqueId: number;
  /**
   * The live frame: `ReplayFrameNumEnd` on an in-car tick (`resolveReplayFrame`),
   * `ReplayFrameNum + ReplayFrameNumEnd` on an out-of-car tick at the live edge.
   */
  frame: number;
};

/**
 * The tick's session identity and live frame when a replay recorder may record
 * from it, `null` when it may not — the one statement of the gate in the
 * module comment. `inReplay` is the translator's read of the controller's
 * debounced replay state, taken as given.
 */
export function resolveReplayRecordTick(telemetry: TelemetryData, inReplay: boolean): ReplayRecordTick | null {
  if (inReplay) return null;

  const sessionNum = telemetry.SessionNum;

  if (typeof sessionNum !== "number" || !(sessionNum >= 0)) return null;

  const frame = resolveReplayFrame(telemetry);

  if (frame === null) return null;

  return {
    sessionNum,
    sessionUniqueId: typeof telemetry.SessionUniqueID === "number" ? telemetry.SessionUniqueID : 0,
    frame,
  };
}

/**
 * How far from the end of the tape, in frames, an out-of-car cursor may sit
 * and still count as at the live edge — 2 s. Measured at the edge,
 * `ReplayFrameNumEnd` reads 1; the nearest scrubbed-back reading measured is
 * 1201 (#1426).
 */
export const LIVE_EDGE_MAX_FRAMES = 120;

/**
 * The tick's session identity and live frame when it shows the live session,
 * in the car or out of it at the live edge; `null` otherwise — the second
 * class of tick in the module comment. In the car (`inReplay` false) it is
 * {@link resolveReplayRecordTick}'s own answer. Out of the car it asks for a
 * live session (`replayOnlySession` false: the translator's
 * `isReplayOnlySession` reading, taken as given), the tick's own raw
 * `IsReplayPlaying` true, `SessionNum >= 0`, and the cursor within
 * {@link LIVE_EDGE_MAX_FRAMES} of the end of the tape, and the frame is
 * `ReplayFrameNum + ReplayFrameNumEnd`.
 */
export function resolveReplayLiveTick(
  telemetry: TelemetryData,
  inReplay: boolean,
  replayOnlySession: boolean,
): ReplayRecordTick | null {
  if (!inReplay) return resolveReplayRecordTick(telemetry, false);

  // The raw flag first: nothing else on a tick it does not vouch for is read.
  if (replayOnlySession || telemetry.IsReplayPlaying !== true) return null;

  const sessionNum = telemetry.SessionNum;

  if (typeof sessionNum !== "number" || !(sessionNum >= 0)) return null;

  const cursor = telemetry.ReplayFrameNum;
  const toEnd = telemetry.ReplayFrameNumEnd;

  if (typeof cursor !== "number" || !Number.isFinite(cursor) || cursor < 0) return null;

  if (typeof toEnd !== "number" || !(toEnd >= 0 && toEnd <= LIVE_EDGE_MAX_FRAMES)) return null;

  return {
    sessionNum,
    sessionUniqueId: typeof telemetry.SessionUniqueID === "number" ? telemetry.SessionUniqueID : 0,
    frame: cursor + toEnd,
  };
}

/** `WeekendInfo.SubSessionID`; 0 when absent — an offline session reads 0 too. */
export function resolveSubSessionId(sessionInfo: Record<string, unknown> | null): number {
  const weekend = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;
  const id = weekend?.SubSessionID;

  return typeof id === "number" && Number.isFinite(id) ? id : 0;
}
