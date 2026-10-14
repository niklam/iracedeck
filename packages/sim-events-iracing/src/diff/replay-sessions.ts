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
 *   tick with no readable `SessionTime`, or a reading for another pair breaks
 *   it. Agreement does not catch a seek, whose readings can hold still for a
 *   quarter of a second; the raw-flag condition of the gate does.
 * - **A pair is published once**: `(sessionNum, sessionUniqueId)` already
 *   published is never published again. A restarted offline event repeats a
 *   `sessionNum` under a new `sessionUniqueId` (maintainer, 2026-10-12), which
 *   is a new pair, published when it is seen, further along the tape.
 * - **Its state survives the translator's wipes**, unlike the other replay
 *   recorders': it records from replay ticks (out of the car at the live
 *   edge), so the wipe on entering and on leaving the replay says nothing
 *   about its readings, and a wiped published list would publish the session
 *   again on every trip between the car and the garage. Its own gate already
 *   breaks the run on every tick it may not read. Only a disconnect clears it;
 *   a reconnect into the same session publishes it once more, which the store
 *   absorbs (its first entry for a pair stays).
 * - **The publish logs one debug line** with the tick's frame and
 *   `SessionTime`, which is what the manual session capture reads.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import type { TranslatorState } from "../state.js";
import { resolveReplayLiveTick, resolveSubSessionId } from "./replay-record-gate.js";
import type { EmitFn } from "./types.js";

/** Replay frames per second of session time: the live frame counter's rate. */
const FRAMES_PER_SECOND = 60;

/** How far apart, in frames, two consecutive readings of one start may be and still agree. */
export const SESSION_START_AGREEMENT_FRAMES = 2;

/** The key a published pair is remembered by. */
function pairKey(sessionNum: number, sessionUniqueId: number): string {
  return `${sessionNum}:${sessionUniqueId}`;
}

/**
 * @param inReplay - The translator's read of the controller's debounced replay state (#1324)
 * @param replayOnlySession - The translator's `isReplayOnlySession` reading for the tick (#604)
 * @param logger - Takes the per-publish debug line; silent when omitted
 */
export function diffReplaySessions(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  inReplay: boolean,
  replayOnlySession: boolean,
  emit: EmitFn,
  logger: ILogger = silentLogger,
): void {
  const live = resolveReplayLiveTick(telemetry, inReplay, replayOnlySession);
  const sessionTimeS = telemetry.SessionTime;

  if (live === null || typeof sessionTimeS !== "number" || !(sessionTimeS >= 0)) {
    state.replaySessionsCandidate = null;

    return;
  }

  const { sessionNum, sessionUniqueId, frame } = live;
  const key = pairKey(sessionNum, sessionUniqueId);

  if (state.replaySessionsPublished.includes(key)) {
    state.replaySessionsCandidate = null;

    return;
  }

  const start = Math.max(0, frame - Math.round(sessionTimeS * FRAMES_PER_SECOND));
  const previous = state.replaySessionsCandidate;
  const agrees =
    previous !== null &&
    previous.sessionNum === sessionNum &&
    previous.sessionUniqueId === sessionUniqueId &&
    Math.abs(previous.start - start) <= SESSION_START_AGREEMENT_FRAMES;

  if (!agrees) {
    state.replaySessionsCandidate = { sessionNum, sessionUniqueId, start };

    return;
  }

  state.replaySessionsCandidate = null;
  state.replaySessionsPublished.push(key);

  logger.debug(
    `Replay session start: frame=${start} (tick frame=${frame} sessionTime=${sessionTimeS.toFixed(3)} ` +
      `inCar=${!inReplay}) SessionNum=${sessionNum} SessionUniqueID=${sessionUniqueId}`,
  );
  emit({
    event: "replay.sessionStarted",
    data: {
      subSessionId: resolveSubSessionId(sessionInfo),
      sessionNum,
      sessionUniqueId,
      frame: start,
    },
  });
}
