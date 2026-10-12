/**
 * What the replay recorders share: which ticks are live enough to record
 * from, and the session identity a recorded moment carries.
 *
 * A replay recorder is a diff that notes a moment of the live session — a
 * car's lap start (`replay-laps.ts`, #1203), the green flag
 * (`replay-greens.ts`, #1354) — with the replay frame it happened at, for
 * @iracedeck/replay-store's per-session file. Every one of them asks the
 * question here rather than answering it itself: two records that disagreed
 * about which ticks are live would put a frame in one section that another
 * calls unobservable.
 *
 * **A tick is eligible** when it is not in a replay — the translator's
 * `inReplay`, the controller's debounced replay state (#1324): false only once
 * `IsReplayPlaying` has read false for the exit grace, and never in a saved
 * replay (#604's `SimMode` — a `.rpy` has nothing live in it), so a seek's
 * blip tick is not eligible either — `SessionNum >= 0`, and a frame is
 * readable. Under that gate `resolveReplayFrame` reads `ReplayFrameNumEnd`,
 * the live frame, which a recorder stores raw (#1162: no lag correction).
 *
 * What a recorder does with an ineligible tick is its own business, and the
 * shape is the same for each: mark itself unseeded, so the first eligible
 * tick after it re-seeds every baseline without emitting. That is also why a
 * recorder runs BEFORE the translator's replay guard — the guard's early
 * return would hide exactly the ticks it has to notice it cannot see — and
 * why its state is left out of what `wipeStateForReplay` preserves.
 *
 * A recorder that needs more of a tick than this (the lap record needs
 * `CarIdxLapCompleted`) adds its own condition on top; it never loosens this
 * one.
 */
import { resolveReplayFrame, type TelemetryData } from "@iracedeck/iracing-sdk";

/** The identity and frame of an eligible tick — see {@link resolveReplayRecordTick}. */
export type ReplayRecordTick = {
  sessionNum: number;
  /**
   * `SessionUniqueID`, which is on every live tick; a build without it reads 0
   * on every tick, so the pair still keys one record per `SessionNum`.
   */
  sessionUniqueId: number;
  /** `resolveReplayFrame(telemetry)`: `ReplayFrameNumEnd` on an eligible tick. */
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

/** `WeekendInfo.SubSessionID`; 0 when absent — an offline session reads 0 too. */
export function resolveSubSessionId(sessionInfo: Record<string, unknown> | null): number {
  const weekend = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;
  const id = weekend?.SubSessionID;

  return typeof id === "number" && Number.isFinite(id) ? id : 0;
}
