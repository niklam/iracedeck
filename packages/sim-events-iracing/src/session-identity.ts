/**
 * The session-identity rule (issues #564, #604, #1509): which tick starts a
 * different session. Stated once here so that every subscriber that resets on
 * a session change — the translator's per-session wipe and `session.changed`,
 * the replay recorder's baseline reset — answers it the same way, each from
 * its own {@link SessionIdentityBaseline}.
 *
 * - **The identity is `(SubSessionID, SessionNum)`** (#1509). An official
 *   race's registration practice and the race event's own practice are both
 *   `SessionNum 0` on one live connection; only `WeekendInfo.SubSessionID`
 *   tells them apart. A tick whose session info carries no readable
 *   `SubSessionID` neither seeds nor compares that half (an offline session
 *   genuinely reads 0, so a missing one is not 0), so a transition that reads
 *   `N`, then nothing, then `M` changes the session once.
 * - **A saved replay is never a change, and never moves the baseline** (#604).
 *   Scrubbing across a session boundary in the replay UI flips `SessionNum` to
 *   the scrubbed-to value; advancing on it would make the return to live read
 *   as a phantom change measured against the scrubbed value. The discriminator
 *   is `WeekendInfo.SimMode` (`isReplayOnlySession`), which does NOT flip
 *   during the brief `IsReplayPlaying` flicker between live sessions, so a
 *   qualifying → race transition through replay-mode ticks (#568) is still a
 *   change. It is read from this tick's session info, and only on a tick with
 *   a `SessionNum`, so a tick without session info reads `false` here — unlike
 *   the controller's sticky `ReplayState.replayOnlySession`.
 * - **Every tick counts, replay-mode ticks included** (#564): the baseline is
 *   not part of any state a replay view wipes, so the transition cannot slip
 *   past a wipe. Only a disconnect resets it.
 * - **A change taken on `SessionNum` alone, on a tick with no readable
 *   `SubSessionID`, forgets the old subsession**: it no longer names the
 *   session we are in, so the next readable id seeds rather than compares, or
 *   a transition read as `(N, 0)`, `(?, 1)`, `(M, 1)` would change twice.
 *
 * Two steps, so a caller decides what happens between them:
 * {@link readSessionIdentity} reads the tick against the baseline and changes
 * nothing, and {@link advanceSessionIdentity} returns the baseline the next
 * tick is read against. The translator publishes `session.changed` (and logs
 * it) between the two, so a subscriber that reads its trackers during that
 * publish still sees the previous session's.
 */
import { isReplayOnlySession, type TelemetryData } from "@iracedeck/iracing-sdk";

import { readSubSessionId } from "./diff/replay-record-gate.js";

/**
 * The last session identity a subscriber observed outside a saved replay —
 * what the next tick is compared against. Reset to
 * {@link createSessionIdentityBaseline} on a disconnect, and never otherwise.
 */
export type SessionIdentityBaseline = {
  /** `telemetry.SessionNum` on the last tick that advanced the baseline; `null` until one did. */
  readonly lastObservedSessionNum: number | null;
  /**
   * `WeekendInfo.SubSessionID` on the last tick that advanced the baseline
   * with a readable one; `null` until one did, and again after a change taken
   * on `SessionNum` alone with no readable id.
   */
  readonly lastObservedSubSessionId: number | null;
};

/** A session change, as {@link readSessionIdentity} reports one. */
export type SessionIdentityChange = {
  /**
   * The `SessionNum` the change is from: the baseline's. A subsession change
   * keeps `SessionNum`, so `from === to` then. Falls back to this tick's
   * only to stay a number — it never does: a change needs a baseline, and a
   * `SubSessionID` baseline is only ever set beside a `SessionNum` one.
   */
  previousSessionNum: number;
  /** The `SessionNum` the change is to: this tick's. */
  sessionNum: number;
  /** The baseline's `SubSessionID`; `null` when it had none. */
  previousSubSessionId: number | null;
  /** This tick's `SubSessionID`; `null` when its session info carries none. */
  subSessionId: number | null;
  /** Whether the `SubSessionID` half changed (both readable and different), with or without `SessionNum`. */
  subSessionChanged: boolean;
};

/** One tick read against a {@link SessionIdentityBaseline}. */
export type SessionIdentityReading = {
  /** `telemetry.SessionNum`, or `null` when the tick carries none. */
  sessionNum: number | null;
  /**
   * The session info this reading was taken from: read once, and only on a
   * tick with a `SessionNum`; `null` otherwise or when the controller has none.
   */
  sessionInfo: Record<string, unknown> | null;
  /**
   * Whether this tick's session info is a saved replay
   * (`isReplayOnlySession`); `false` on a tick without a `SessionNum`, where
   * the session info is not read. The translator's other pre-guard gates (the
   * standing-start countdown) read this same answer.
   */
  replayOnlySession: boolean;
  /** `WeekendInfo.SubSessionID` from {@link sessionInfo}, or `null` when not readable. */
  subSessionId: number | null;
  /** Whether `SessionNum` differs from a `SessionNum` baseline (which must exist). */
  sessionNumChanged: boolean;
  /** The change this tick starts, or `null` when it starts none. */
  change: SessionIdentityChange | null;
};

/** The baseline before any tick, and after a disconnect: nothing observed. */
export function createSessionIdentityBaseline(): SessionIdentityBaseline {
  return { lastObservedSessionNum: null, lastObservedSubSessionId: null };
}

/**
 * Read one tick against `baseline` — the rule in the module comment — without
 * changing anything. `readSessionInfo` is called once, and only when the tick
 * carries a `SessionNum`.
 */
export function readSessionIdentity(
  baseline: SessionIdentityBaseline,
  telemetry: TelemetryData,
  readSessionInfo: () => Record<string, unknown> | null,
): SessionIdentityReading {
  const sessionNum = telemetry.SessionNum ?? null;
  const sessionInfo = sessionNum !== null ? readSessionInfo() : null;
  const replayOnlySession = sessionNum !== null ? isReplayOnlySession(sessionInfo) : false;
  const subSessionId = sessionNum !== null ? readSubSessionId(sessionInfo) : null;

  const sessionNumChanged = baseline.lastObservedSessionNum !== null && sessionNum !== baseline.lastObservedSessionNum;
  const subSessionChanged =
    subSessionId !== null &&
    baseline.lastObservedSubSessionId !== null &&
    subSessionId !== baseline.lastObservedSubSessionId;

  const change: SessionIdentityChange | null =
    !replayOnlySession && sessionNum !== null && (sessionNumChanged || subSessionChanged)
      ? {
          previousSessionNum: baseline.lastObservedSessionNum ?? sessionNum,
          sessionNum,
          previousSubSessionId: baseline.lastObservedSubSessionId,
          subSessionId,
          subSessionChanged,
        }
      : null;

  return { sessionNum, sessionInfo, replayOnlySession, subSessionId, sessionNumChanged, change };
}

/**
 * The baseline the next tick is read against, after `reading`: advanced on a
 * tick with a `SessionNum` outside a saved replay, `baseline` itself
 * otherwise. Not changed in place.
 */
export function advanceSessionIdentity(
  baseline: SessionIdentityBaseline,
  reading: SessionIdentityReading,
): SessionIdentityBaseline {
  if (reading.sessionNum === null || reading.replayOnlySession) return baseline;

  let lastObservedSubSessionId = baseline.lastObservedSubSessionId;

  if (reading.subSessionId !== null) {
    lastObservedSubSessionId = reading.subSessionId;
  } else if (reading.sessionNumChanged) {
    // The change was taken on SessionNum alone, so the old subsession no
    // longer names the session we are in (see the module comment).
    lastObservedSubSessionId = null;
  }

  return { lastObservedSessionNum: reading.sessionNum, lastObservedSubSessionId };
}
