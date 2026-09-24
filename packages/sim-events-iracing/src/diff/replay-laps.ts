/**
 * The replay lap record (issue #1203): every car's lap-start frame and lap
 * time, detected live and published as `replay.lapStarted` / `replay.lapTimed`
 * for the deck-core replay store, so Jump to Fastest Lap is a lookup.
 * Design: docs/superpowers/specs/2026-09-24-issue-1203-fastest-lap-from-session-record.md.
 *
 * A per-car previous-tick baseline over `CarIdxLapCompleted` (the
 * `opponent-pit.ts` shape: baselines advance element-wise every tick).
 *
 * - **A crossing is the counter rising by exactly 1** from a non-negative
 *   baseline, or from −1 to 0 — the first S/F crossing, since the counter is
 *   −1 for every car until then (#307). The car starts lap `completed + 1`
 *   (what `CarIdxLap` reads; `gap-utils.ts` records the two differ by one at
 *   the line) at `resolveReplayFrame(telemetry)`, which under the gate below
 *   is `ReplayFrameNumEnd` — the live frame, recorded raw (#1162: no lag
 *   correction).
 * - **Any other change re-seeds the car silently**: a jump of more than one
 *   (a tow, a reset, a late join with laps already scored), a decrease, a
 *   return from −1 to a positive number. The replay cannot show those, and an
 *   invented entry would put a wrong frame in the file. A re-seed also drops
 *   the car's open lap-time wait: the time a tow interrupts is not a lap's.
 * - **The lap time lags the crossing.** iRacing refreshes `CarIdxLastLapTime`
 *   a tick or two after the counter moves (the player-side `diff/laps.ts`
 *   triggers on `LapLastLapTime` changing for the same reason), so a crossing
 *   opens a per-car wait: the first tick the time moves off the value it held
 *   the tick BEFORE the crossing and is positive publishes it for the lap just
 *   completed. Baselining on the previous tick rather than the crossing tick
 *   also catches a refresh that lands on the crossing tick itself. A
 *   `REPLAY_LAP_TIME_WAIT_TICKS` budget closes the wait with no time; two
 *   byte-identical consecutive laps leave the second untimed — the
 *   improbability `diff/laps.ts` accepts. A first crossing (−1 → 0) opens no
 *   wait: no lap was completed.
 * - **Gate: record only what is live and observable.** A tick is eligible
 *   when `IsReplayPlaying !== true` (the per-car arrays follow the replay
 *   cursor while a replay is on screen), the session is not replay-only
 *   (#604's `SimMode` — a `.rpy` has nothing live in it), `SessionNum >= 0`,
 *   and a frame is readable. Every ineligible tick marks the recorder
 *   unseeded; the first eligible tick after it re-seeds every baseline
 *   without emitting, so a driver returning from the garage or the replay
 *   view to a field that crossed the line meanwhile produces no fabricated
 *   crossings — those laps are absent from the record and fall through to the
 *   walk. This is why the diff runs BEFORE the translator's replay guard: the
 *   guard's early return would stop it on exactly the ticks it has to notice
 *   it cannot see.
 * - **Session change** (`SessionNum` or `SessionUniqueID` moves) re-seeds; the
 *   store starts a new session record from the events' identity.
 * - **The pace car is skipped** (`resolvePaceCarIdx`), and so is a car the
 *   session YAML cannot name: the record is verified by `carNumberRaw` at
 *   lookup, so an entry without one could never answer.
 */
import { getCarNumberRawFromSessionInfo, resolveReplayFrame, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ReplayLapTimeWait, TranslatorState } from "../state.js";
import { resolvePaceCarIdx } from "./pace-laps.js";
import type { EmitFn } from "./types.js";

/**
 * Ticks a crossing waits for `CarIdxLastLapTime` to refresh before the lap is
 * left untimed — 2 s at the 60 Hz tick, against a refresh measured at a tick
 * or two.
 */
export const REPLAY_LAP_TIME_WAIT_TICKS = 120;

/** `DriverInfo.Drivers[].UserID` for a car, or null when the roster does not name it. */
function resolveDriverUserId(sessionInfo: Record<string, unknown> | null, carIdx: number): number | null {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown> | null> | undefined;

  if (!Array.isArray(drivers)) return null;

  const driver = drivers.find((d) => d?.CarIdx === carIdx);
  const userId = driver?.UserID;

  return typeof userId === "number" && Number.isFinite(userId) ? userId : null;
}

/** `WeekendInfo.SubSessionID`; 0 when absent — an offline session reads 0 too. */
function resolveSubSessionId(sessionInfo: Record<string, unknown> | null): number {
  const weekend = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;
  const id = weekend?.SubSessionID;

  return typeof id === "number" && Number.isFinite(id) ? id : 0;
}

function seed(
  state: TranslatorState,
  completed: readonly number[],
  lastLapTime: readonly number[] | undefined,
  sessionNum: number,
  sessionUniqueId: number,
): void {
  state.replayLapsSeeded = true;
  state.replayLapsSessionNum = sessionNum;
  state.replayLapsSessionUniqueId = sessionUniqueId;
  state.replayLapsLastCompleted = completed.slice();
  state.replayLapsLastLapTime = lastLapTime ? lastLapTime.slice() : [];
  state.replayLapsTimeWait = [];
}

export function diffReplayLaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  replayOnlySession: boolean,
  emit: EmitFn,
): void {
  const completed = telemetry.CarIdxLapCompleted;
  const sessionNum = telemetry.SessionNum;
  const frame = resolveReplayFrame(telemetry);
  const eligible =
    telemetry.IsReplayPlaying !== true &&
    !replayOnlySession &&
    typeof sessionNum === "number" &&
    sessionNum >= 0 &&
    frame !== null &&
    Array.isArray(completed);

  if (!eligible) {
    state.replayLapsSeeded = false;

    return;
  }

  // `SessionUniqueID` is on every live tick; a build without it reads 0 on
  // every tick, so the pair still keys one record per `SessionNum`.
  const sessionUniqueId = typeof telemetry.SessionUniqueID === "number" ? telemetry.SessionUniqueID : 0;
  const lastLapTime = telemetry.CarIdxLastLapTime;

  if (
    !state.replayLapsSeeded ||
    sessionNum !== state.replayLapsSessionNum ||
    sessionUniqueId !== state.replayLapsSessionUniqueId
  ) {
    seed(state, completed, lastLapTime, sessionNum, sessionUniqueId);

    return;
  }

  const prevCompleted = state.replayLapsLastCompleted;
  const prevLapTime = state.replayLapsLastLapTime;
  const waits = state.replayLapsTimeWait;
  // Resolved on the first crossing of the tick, not per tick: a roster scan
  // for a field that crosses the line once a lap is wasted on the other 59 ticks.
  let identity: { subSessionId: number; paceCarIdx: number | null } | null = null;

  for (let carIdx = 0; carIdx < completed.length; carIdx++) {
    const cur = completed[carIdx];
    // A car slot the seed did not see (the array grew) has no baseline.
    const prev: number | undefined = prevCompleted[carIdx];
    const timeS = lastLapTime?.[carIdx];
    const wait = waits[carIdx] ?? null;

    // The open lap-time wait, checked before the crossing so a refresh that
    // lands on a crossing tick is still read against the pre-crossing baseline.
    if (wait !== null) {
      if (typeof timeS === "number" && timeS > 0 && timeS !== wait.baselineS) {
        identity ??= { subSessionId: resolveSubSessionId(sessionInfo), paceCarIdx: resolvePaceCarIdx(sessionInfo) };
        emit({
          event: "replay.lapTimed",
          data: {
            subSessionId: identity.subSessionId,
            sessionNum,
            sessionUniqueId,
            carIdx,
            lap: wait.lap,
            timeMs: Math.round(timeS * 1000),
          },
        });
        waits[carIdx] = null;
      } else if (wait.ticksLeft <= 1) {
        waits[carIdx] = null;
      } else {
        wait.ticksLeft -= 1;
      }
    }

    if (prev !== undefined && cur !== prev) {
      const crossing = (prev >= 0 && cur === prev + 1) || (prev === -1 && cur === 0);

      if (crossing) {
        identity ??= { subSessionId: resolveSubSessionId(sessionInfo), paceCarIdx: resolvePaceCarIdx(sessionInfo) };
        const carNumberRaw =
          carIdx === identity.paceCarIdx ? null : getCarNumberRawFromSessionInfo(sessionInfo, carIdx);

        if (carNumberRaw !== null) {
          emit({
            event: "replay.lapStarted",
            data: {
              subSessionId: identity.subSessionId,
              sessionNum,
              sessionUniqueId,
              carIdx,
              carNumberRaw,
              userId: resolveDriverUserId(sessionInfo, carIdx) ?? 0,
              lap: cur + 1,
              frame,
            },
          });

          // A crossing from a scored lap opens the wait for that lap's time; the
          // first crossing (−1 → 0) completed nothing. Either way the previous
          // wait — an older lap the sim never timed inside its budget — closes.
          const opened: ReplayLapTimeWait | null =
            prev >= 0 ? { lap: cur, baselineS: prevLapTime[carIdx] ?? 0, ticksLeft: REPLAY_LAP_TIME_WAIT_TICKS } : null;
          waits[carIdx] = opened;
        } else {
          waits[carIdx] = null;
        }
      } else {
        // Not a crossing the replay can show — re-seed the car silently.
        waits[carIdx] = null;
      }
    }

    prevCompleted[carIdx] = cur;
    prevLapTime[carIdx] = typeof timeS === "number" ? timeS : (prevLapTime[carIdx] ?? 0);
  }
}
