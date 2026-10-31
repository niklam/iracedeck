/**
 * The replay green record (issue #1354): the frame the race went green at, and
 * the frame of every caution restart, detected live and published as
 * `replay.greenFlag` for @iracedeck/replay-store, so Jump to Race Start is a
 * lookup.
 * Design: docs/superpowers/specs/2026-10-05-issue-1354-replay-jump-to-green-flag.md.
 *
 * Two edges over a previous-tick baseline of `SessionState` and `SessionFlags`
 * (the `replay-laps.ts` shape: the baseline advances on every eligible tick):
 *
 * - **The race start is `SessionState` entering `Racing` from a real pre-green
 *   state**: the previous eligible tick read `GetInCar`, `Warmup` or
 *   `ParadeLaps`. The state, not a flag bit: `StartGo` also rises on every
 *   caution restart, `Green` rises under a yellow-checkered finish, and a
 *   green can lead `StartGo` by a tick — the flag and start-light diffs tell
 *   those apart with the caution phase, which is post-guard state this diff
 *   cannot read. `SessionState` has one meaning here and needs none of it.
 *   `Invalid` is deliberately NOT a pre-green state for this edge, though
 *   `isPreGreen` counts it: an `Invalid → Racing` step is what a reconnect or
 *   a session-YAML reload mid-race looks like, and recording it would put a
 *   mid-race frame in the file as the start. Hence the diff's own three-state
 *   set. A re-grid re-enters `ParadeLaps`, and its green is a second `start`
 *   for the same session instance: the store keeps the latest.
 * - **A restart is the green that ends a full-course caution**: `Green` rising
 *   in `Racing` with neither `Caution` nor `CautionWaving` set on that tick
 *   (`isRestartGreenEdge`, the predicate `caution.restarted` is decided by —
 *   shared with `caution.ts`, not copied), while a caution is out. A green
 *   rising with `Caution` still set — a yellow-checkered tick — is not one.
 *   "A caution is out" is this diff's own reading, because the caution phase
 *   it would otherwise read is wiped on every replay tick: a caution bit was
 *   set on the previous eligible tick of this session, which the flags
 *   baseline already holds. Like that phase it falls the moment neither bit is
 *   set, so the restart is the green rising on the tick the bits drop, which
 *   is what both #1127 captures show (oval
 *   `0x10044600` → `0x80040004`). The unmeasured orderings — the bits dropping
 *   a tick before or after the green rises — record nothing, as they announce
 *   nothing: an absent entry, never a wrong one. A latch left standing past
 *   the caution would instead call the next plain green of the race a restart.
 * - **A tick is one edge at most, and the start wins.** A green rising on the
 *   very tick the state enters `Racing` is the start's own green, whatever the
 *   flags read on the formation lap.
 * - **Race sessions only**, judged the way `handleTick` judges it for every
 *   other diff: the session YAML's `SessionType` for this `SessionNum` is
 *   `"Race"` (`resolveSessionType`). Practice and qualifying also sit in
 *   `Racing` and show a green bit, but a green there is not a start anyone
 *   reviews — and an unknown session type (the YAML not parsed yet) records
 *   nothing rather than guessing. Resolved only on a tick that has an edge.
 * - **Gate: the replay recorders' own** (`resolveReplayRecordTick`,
 *   `replay-record-gate.ts`). Every ineligible tick — a replay, the seek blip,
 *   a saved replay, `SessionNum` −1, no frame — marks the recorder unseeded;
 *   the first eligible tick after it re-seeds every baseline, the flags the
 *   caution is read from included, without emitting, even across a `Racing`
 *   flip. So a driver who sat in the
 *   garage through the green (where iRacing reports `IsReplayPlaying: true`)
 *   gets no start entry and the press falls back, and a restart taken behind a
 *   replay glance is simply absent. This is why the diff runs BEFORE the
 *   translator's replay guard: the guard's early return would stop it on
 *   exactly the ticks it has to notice it cannot see.
 * - **Session change** (`SessionNum` or `SessionUniqueID` moves) re-seeds, so
 *   a caution of the old session is never read into the new one.
 * - **The payload is the edge tick's own**: `frame` is the gate's frame —
 *   `ReplayFrameNumEnd`, recorded raw like a lap start (#1162: no lag
 *   correction) — and `sessionTimeMs` is `SessionTime` in whole milliseconds,
 *   the one frame-free coordinate of the moment (0 on a tick that carries no
 *   `SessionTime`; nothing reads it yet).
 * - **Every edge logs one debug line** with the state and the flags on both
 *   sides of it. That line is the capture the design asks for: on a standing
 *   and a rolling start it shows whether `StartGo` / `Green` was already up,
 *   rose on the flip tick, or had not risen yet.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { Flags, hasAnyFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import type { ReplayRecorderState } from "../replay-recorder-state.js";
import { resolveSessionType } from "../session-type.js";
import { isRestartGreenEdge } from "./caution.js";
import { resolveReplayRecordTick, resolveSubSessionId } from "./replay-record-gate.js";
import type { EmitFn } from "./types.js";

/**
 * The states a race start is entered FROM. Not `isPreGreen`: that one counts
 * `Invalid`, and an `Invalid → Racing` step is a reconnect, not a start.
 */
const PRE_GREEN_STATES: ReadonlySet<number> = new Set([
  SessionState.GetInCar,
  SessionState.Warmup,
  SessionState.ParadeLaps,
]);

/** The two caution bits, either of which means a full-course caution. */
const CAUTION_FLAGS = [Flags.Caution, Flags.CautionWaving] as const;

/** Whether a full-course caution is out on a tick: either caution bit. */
function isCautionOut(flags: number): boolean {
  return hasAnyFlag(flags, CAUTION_FLAGS);
}

/** `SessionFlags` as unsigned hex — `StartGo` is the sign bit, and a signed print would hide it. */
function hex(flags: number): string {
  return `0x${(flags >>> 0).toString(16).padStart(8, "0")}`;
}

/** The events {@link diffReplayGreens} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const REPLAY_GREENS_EVENTS = ["replay.greenFlag"] as const satisfies readonly SimEventName[];

/**
 * @param inReplay - The translator's read of the controller's debounced replay state (#1324)
 * @param logger - Takes the per-edge debug line; silent when omitted
 */
export function diffReplayGreens(
  state: ReplayRecorderState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  inReplay: boolean,
  emit: EmitFn<(typeof REPLAY_GREENS_EVENTS)[number]>,
  logger: ILogger = silentLogger,
): void {
  const live = resolveReplayRecordTick(telemetry, inReplay);

  if (live === null) {
    state.replayGreensSeeded = false;

    return;
  }

  const { sessionNum, sessionUniqueId, frame } = live;
  const sessionState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
  const flags = telemetry.SessionFlags ?? 0;

  const seeding =
    !state.replayGreensSeeded ||
    sessionNum !== state.replayGreensSessionNum ||
    sessionUniqueId !== state.replayGreensSessionUniqueId;
  const wasSessionState = state.replayGreensLastSessionState;
  const wasFlags = state.replayGreensLastFlags;

  // The baselines advance on every eligible tick, the seed included.
  state.replayGreensSeeded = true;
  state.replayGreensSessionNum = sessionNum;
  state.replayGreensSessionUniqueId = sessionUniqueId;
  state.replayGreensLastSessionState = sessionState;
  state.replayGreensLastFlags = flags;

  if (seeding || sessionState !== SessionState.Racing) return;

  // The start is checked first and a tick is one edge at most — see the module comment.
  let kind: "start" | "restart" | null = null;

  if (PRE_GREEN_STATES.has(wasSessionState)) kind = "start";
  else if (isCautionOut(wasFlags) && isRestartGreenEdge(wasFlags, flags)) kind = "restart";

  // Resolved on an edge, not per tick: a session-YAML lookup for a moment
  // that comes a handful of times a race is wasted on every other tick.
  if (kind === null || resolveSessionType(sessionInfo, telemetry) !== "Race") return;

  const sessionTimeS =
    typeof telemetry.SessionTime === "number" && Number.isFinite(telemetry.SessionTime) ? telemetry.SessionTime : 0;

  logger.debug(
    `Replay green: kind=${kind} frame=${frame} sessionTime=${sessionTimeS.toFixed(3)} ` +
      `SessionState=${wasSessionState}→${sessionState} SessionFlags=${hex(wasFlags)}→${hex(flags)} ` +
      `SessionNum=${sessionNum} SessionUniqueID=${sessionUniqueId}`,
  );
  emit({
    event: "replay.greenFlag",
    data: {
      subSessionId: resolveSubSessionId(sessionInfo),
      sessionNum,
      sessionUniqueId,
      kind,
      frame,
      sessionTimeMs: Math.round(sessionTimeS * 1000),
    },
  });
}
