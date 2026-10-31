/**
 * The replay session record (issue #1426): the frame each session of the tape
 * began at, published once per session instance as `replay.sessionStarted`
 * for @iracedeck/replay-store, so Next / Previous Session step from the record.
 * Design: docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md.
 *
 * - **A session's start is `live frame − round(SessionTime × 60)`, clamped at
 *   0**, read on a tick that shows the session live. In the car
 *   `ReplayFrameNumEnd − SessionTime × 60` is constant for a session to within
 *   a frame (five sessions measured, #1426), so the sum gives the same frame
 *   on the change tick, where `SessionTime` is near zero, and ten minutes in,
 *   when the plugin started mid-session or the driver sat in the replay as the
 *   session rolled over. One rule, and no separate path for a missed change. A
 *   negative result is a session that began before the tape did; its start is
 *   the tape's, 0.
 * - **Gate: the live-tick resolver** (`resolveReplayLiveTick`,
 *   `replay-record-gate.ts`): in the car, or out of it at the live edge of a
 *   live session, where the frame is `ReplayFrameNum + ReplayFrameNumEnd` and
 *   the tick's own raw `IsReplayPlaying` is the seek guard. A replay scrubbed
 *   back is not live, so a scrub across a session boundary records nothing
 *   whatever `SessionNum` does there (not measured); the session is recorded
 *   on the first tick the driver is back at the edge or in the car, at the
 *   same frame.
 * - **Two consecutive live ticks must agree** on a pair's start to within
 *   {@link SESSION_START_AGREEMENT_FRAMES}, so a tick on which the session
 *   number has moved and the clock has not cannot put a wrong start in the
 *   file. The run is the previous live tick's reading; an ineligible tick, a
 *   tick with no readable `SessionTime`, a tick with no session info, or a
 *   reading for another event (`SubSessionID`) or pair breaks it. Agreement
 *   does not catch a seek, whose readings can hold still for a quarter of a
 *   second; the raw-flag condition of the gate does.
 * - **Both agreeing ticks need session info.** The first ticks of a
 *   connection can read none, and a reading taken there would be filed under
 *   `SubSessionID` 0: the next tick, with session info, would agree with it and
 *   publish at once, before the store has opened the event's record (its
 *   subscriber runs after the translator's and the replay recorder's on that
 *   tick), so the store would
 *   drop the event while the pair counted as published, and the session's
 *   start would never be recorded for that connection. Requiring session info
 *   on both ticks means the store has opened the record on the first of them.
 * - **A new pair's start must come after the event's earlier ones.**
 *   Agreement does not catch a clock that stays stale for two ticks or more
 *   at a session change: the frame and the old `SessionTime` both advance at
 *   60 a second, so the stale readings agree with each other on the previous
 *   session's start, and the store keeps the first start it is given. So a
 *   reading for a new pair that is not later than the latest start already
 *   published for the same `SubSessionID` (by more than
 *   {@link SESSION_START_AGREEMENT_FRAMES}, the readings' own jitter) is
 *   refused: the run is dropped, a debug line says so, and the first tick
 *   with a fresh clock starts the run that records it. Every later session
 *   of an event, a restarted offline event's included, is later on the tape.
 *   The latest start survives the resets with the published list.
 * - **A pair is published once**: `(sessionNum, sessionUniqueId)` already
 *   published for the event (`SubSessionID`) is never published again; the
 *   event is part of the key because the list outlives a session change and
 *   a later event in the same sim run can repeat the pair. A restarted offline event repeats a
 *   `sessionNum` under a new `sessionUniqueId` (maintainer, 2026-10-12), which
 *   is a new pair, published when it is seen, further along the tape.
 * - **Its state survives the replay recorder's resets**, unlike the other
 *   replay recorders' (`replay-recorder.ts`): it records from replay ticks
 *   (out of the car at the live edge), so the reset on entering and on
 *   leaving the replay, or at a session change, says nothing about its
 *   readings, and a wiped published list would publish the session
 *   again on every trip between the car and the garage. Its own gate already
 *   breaks the run on every tick it may not read. Only a disconnect clears it;
 *   a reconnect into the same session publishes it once more, which the store
 *   absorbs (its first entry for a pair stays).
 * - **The publish logs one debug line** with the tick's frame and
 *   `SessionTime`, which is what the manual session capture reads.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import type { ReplayRecorderState } from "../replay-recorder-state.js";
import { resolveReplayLiveTick, resolveSubSessionId } from "./replay-record-gate.js";
import type { EmitFn } from "./types.js";

/** Replay frames per second of session time: the live frame counter's rate. */
const FRAMES_PER_SECOND = 60;

/** How far apart, in frames, two consecutive readings of one start may be and still agree. */
export const SESSION_START_AGREEMENT_FRAMES = 2;

/** The key a published pair is remembered by. */
function pairKey(subSessionId: number, sessionNum: number, sessionUniqueId: number): string {
  return `${subSessionId}:${sessionNum}:${sessionUniqueId}`;
}

/** The events {@link diffReplaySessions} emits (issue #1499): its emitter's type, and its row in `REPLAY_RECORDER_ORDER`. */
export const REPLAY_SESSIONS_EVENTS = ["replay.sessionStarted"] as const satisfies readonly SimEventName[];

/**
 * @param sessionInfo - The controller's session info; null on a tick that has
 *   none yet, which records nothing and breaks the run
 * @param inReplay - The controller's debounced replay state (#1324), as the replay recorder reads it on this tick
 * @param replayOnlySession - The controller's sticky saved-replay answer (#604,
 *   `ReplayState.replayOnlySession`), which keeps its value through a tick whose
 *   session info reads null, where a per-tick `isReplayOnlySession` reads false
 * @param logger - Takes the per-publish debug line; silent when omitted
 */
export function diffReplaySessions(
  state: ReplayRecorderState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  inReplay: boolean,
  replayOnlySession: boolean,
  emit: EmitFn<(typeof REPLAY_SESSIONS_EVENTS)[number]>,
  logger: ILogger = silentLogger,
): void {
  const live = resolveReplayLiveTick(telemetry, inReplay, replayOnlySession);
  const sessionTimeS = telemetry.SessionTime;

  if (live === null || typeof sessionTimeS !== "number" || !(sessionTimeS >= 0)) {
    state.replaySessionsCandidate = null;

    return;
  }

  if (sessionInfo === null) {
    state.replaySessionsCandidate = null;

    return;
  }

  const { sessionNum, sessionUniqueId, frame } = live;
  const subSessionId = resolveSubSessionId(sessionInfo);
  const key = pairKey(subSessionId, sessionNum, sessionUniqueId);

  if (state.replaySessionsPublished.includes(key)) {
    state.replaySessionsCandidate = null;

    return;
  }

  const start = Math.max(0, frame - Math.round(sessionTimeS * FRAMES_PER_SECOND));
  const latest: number | undefined = state.replaySessionsLatestStart[subSessionId];

  if (latest !== undefined && start <= latest + SESSION_START_AGREEMENT_FRAMES) {
    state.replaySessionsCandidate = null;
    logger.debug(
      `Replay session start refused: frame=${start} is not after the event's latest start ${latest} ` +
        `(tick frame=${frame} sessionTime=${sessionTimeS.toFixed(3)}) SessionNum=${sessionNum} ` +
        `SessionUniqueID=${sessionUniqueId}`,
    );

    return;
  }

  const previous = state.replaySessionsCandidate;
  const agrees =
    previous !== null &&
    previous.subSessionId === subSessionId &&
    previous.sessionNum === sessionNum &&
    previous.sessionUniqueId === sessionUniqueId &&
    Math.abs(previous.start - start) <= SESSION_START_AGREEMENT_FRAMES;

  if (!agrees) {
    state.replaySessionsCandidate = { subSessionId, sessionNum, sessionUniqueId, start };

    return;
  }

  state.replaySessionsCandidate = null;
  state.replaySessionsPublished.push(key);
  // Every start published passed the guard above, so it is the latest.
  state.replaySessionsLatestStart[subSessionId] = start;

  logger.debug(
    `Replay session start: frame=${start} (tick frame=${frame} sessionTime=${sessionTimeS.toFixed(3)} ` +
      `inCar=${!inReplay}) SessionNum=${sessionNum} SessionUniqueID=${sessionUniqueId}`,
  );
  emit({
    event: "replay.sessionStarted",
    data: {
      subSessionId,
      sessionNum,
      sessionUniqueId,
      frame: start,
    },
  });
}
