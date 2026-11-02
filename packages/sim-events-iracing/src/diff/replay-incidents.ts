/**
 * The replay incident record (issue #1426): every rise of a car's incident
 * count, detected live and published as `replay.incident` for
 * @iracedeck/replay-store with the frame it was seen on. Nothing reads the
 * section yet; Next / Previous Incident keep sending iRacing's search, and a
 * debug line compares where it lands with what was recorded.
 * Design: docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md.
 *
 * Two sources, one recorder, each over a previous-eligible-tick baseline:
 *
 * - **The driver's own car** from `PlayerCarMyIncidentCount`: a rise over the
 *   baseline publishes, `source: "telemetry"`, with `delta` the rise. A
 *   decrease re-seeds silently. The car is `DriverInfo.DriverCarIdx` (the
 *   tick's `PlayerCarIdx` when the session info has none), verified by its
 *   `CarNumberRaw` like every record entry; a car the roster cannot name is
 *   not published.
 * - **Other cars** from the session YAML's `DriverInfo.Drivers[]
 *   .CurDriverIncidentCount`, where the sim shows it: a rise from a
 *   non-negative baseline publishes, `source: "sessionInfo"`. A −1 is no
 *   baseline: an official session hides every opponent's count until it is
 *   over (survey of 2026-09-21), and the step from −1 to a number there is the
 *   reveal, whose frame is long past, so it re-seeds silently. A decrease
 *   re-seeds too, and so does a car the roster had not held.
 * - **A baseline belongs to one driver in one car.** Each other-car baseline
 *   keeps the row's `UserID` and `CarNumberRaw`, and a tick whose row differs
 *   in either re-seeds that slot silently: a driver swap in a team event can
 *   raise `CurDriverIncidentCount` (the new driver's own count), and so can a
 *   new car taking a freed carIdx, and neither is an incident.
 *   The driver's own row is skipped, so the driver is never published twice,
 *   and so are the pace car and spectator rows. The YAML lags the incident by
 *   an amount nobody has measured; the incident comparison is what measures it.
 * - **No burst logic.** One event per rise, at that tick's frame: the store
 *   folds a rise close behind the same car's last entry into it, so one crash
 *   is one entry at its first frame. The Race Engineer's incident diff
 *   (`incidents.ts`) and its burst window are shaped for audio and are not
 *   copied.
 * - **Gate: the lap record's** (`resolveReplayRecordTick`,
 *   `replay-record-gate.ts`), in the car only. Every ineligible tick marks the
 *   recorder unseeded; the first eligible tick after it re-seeds both sources
 *   without emitting, so a count that rose while the driver was in the garage
 *   or the replay view is not stamped with the frame he came back on. That is
 *   why the diff runs in the replay recorder (`replay-recorder.ts`), a
 *   subscriber with no replay guard, and why its baselines are reset at both
 *   edges of a replay view.
 * - **Session change** (`SessionNum` or `SessionUniqueID` moves) re-seeds.
 * - **The payload is the tick's own**: `frame` is the gate's frame, recorded
 *   raw (#1162: no lag correction; the later consumer subtracts its lead-in),
 *   and `sessionTimeMs` is `SessionTime` in whole milliseconds (0 on a tick
 *   that carries none).
 * - **The roster is read once per session-info version**, not per tick:
 *   `IRacingSDK.getSessionInfo()` returns the same object until iRacing bumps
 *   `SessionInfoUpdate`, so the reading is memoised on that object's identity
 *   (the pattern of `iracing-sdk`'s `template-context.ts`), and an in-car tick
 *   at 60 Hz with unchanged session info walks nothing.
 * - **Each car is a unit** (#1559): the driver's own rise and every other
 *   car's run through the `runUnit` the replay recorder hands in, and the
 *   baselines are written after them. A car whose unit throws keeps its
 *   previous baseline (a copy of the roster reading with that slot held back,
 *   since the memoised array is shared), so its rise is read again, and
 *   published, on the next tick; the other cars' rises are published as usual.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { getCarNumberRawFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ReplayIncidentCarReading, ReplayRecorderState } from "../replay-recorder-state.js";
import { runUnitsDirectly, type UnitRunner } from "../tick-steps.js";
import { resolveReplayRecordTick, resolveSubSessionId } from "./replay-record-gate.js";
import type { EmitFn } from "./types.js";

type DriverRow = Record<string, unknown> | null | undefined;

function readDrivers(sessionInfo: Record<string, unknown> | null): DriverRow[] {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers;

  return Array.isArray(drivers) ? (drivers as DriverRow[]) : [];
}

/** The driver's own carIdx: `DriverInfo.DriverCarIdx`, else the tick's `PlayerCarIdx`; `null` when neither names one. */
function resolvePlayerCarIdx(sessionInfo: Record<string, unknown> | null, telemetry: TelemetryData): number | null {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const fromYaml = driverInfo?.DriverCarIdx;

  if (typeof fromYaml === "number" && Number.isInteger(fromYaml) && fromYaml >= 0) return fromYaml;

  const fromTick = telemetry.PlayerCarIdx;

  return typeof fromTick === "number" && Number.isInteger(fromTick) && fromTick >= 0 ? fromTick : null;
}

/** A count as read, or −1 for anything that is not a non-negative whole number — the sim's own "hidden". */
function readCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
}

/** A roster field that names something: a finite number, else `null`. */
function readIdentityField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Other cars' readings, by carIdx: every roster row but the driver's own, the
 * pace car and spectators.
 */
function walkCarReadings(
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number | null,
): ReplayIncidentCarReading[] {
  const readings: ReplayIncidentCarReading[] = [];

  for (const driver of readDrivers(sessionInfo)) {
    const carIdx = driver?.CarIdx;

    if (typeof carIdx !== "number" || !Number.isInteger(carIdx) || carIdx < 0) continue;

    if (carIdx === playerCarIdx || driver?.CarIsPaceCar === 1 || driver?.IsSpectator === 1) continue;

    readings[carIdx] = {
      count: readCount(driver?.CurDriverIncidentCount),
      userId: readIdentityField(driver?.UserID),
      carNumberRaw: readIdentityField(driver?.CarNumberRaw),
    };
  }

  return readings;
}

/**
 * {@link walkCarReadings} memoised on the identity of the session-info object
 * (see the module comment) and the driver's carIdx it skipped. A WeakMap, so a
 * superseded session-info object is not kept alive by its entry. The arrays it
 * hands out are shared between ticks and never mutated.
 */
const carReadingsMemo = new WeakMap<
  object,
  { playerCarIdx: number | null; readings: readonly ReplayIncidentCarReading[] }
>();

const NO_CAR_READINGS: readonly ReplayIncidentCarReading[] = Object.freeze([]);

function readCarReadings(
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number | null,
): readonly ReplayIncidentCarReading[] {
  if (sessionInfo === null) return NO_CAR_READINGS;

  const memo = carReadingsMemo.get(sessionInfo);

  if (memo !== undefined && memo.playerCarIdx === playerCarIdx) return memo.readings;

  const readings = walkCarReadings(sessionInfo, playerCarIdx);

  carReadingsMemo.set(sessionInfo, { playerCarIdx, readings });

  return readings;
}

/** Whether two readings of one slot are the same driver in the same car. */
function sameIdentity(a: ReplayIncidentCarReading, b: ReplayIncidentCarReading): boolean {
  return a.userId === b.userId && a.carNumberRaw === b.carNumberRaw;
}

/** `PlayerCarMyIncidentCount`, or `null` when the tick carries no count. */
function readPlayerCount(telemetry: TelemetryData): number | null {
  const count = readCount(telemetry.PlayerCarMyIncidentCount);

  return count >= 0 ? count : null;
}

/** The events {@link diffReplayIncidents} emits (issue #1499): its emitter's type, and its row in `REPLAY_RECORDER_ORDER`. */
export const REPLAY_INCIDENTS_EVENTS = ["replay.incident"] as const satisfies readonly SimEventName[];

type ReplayIncidentsEmit = EmitFn<(typeof REPLAY_INCIDENTS_EVENTS)[number]>;

/**
 * @param inReplay - The controller's debounced replay state (#1324), as the replay recorder reads it on this tick
 * @param runUnit - Runs the driver's own rise and each other car as a unit (#1559): the replay recorder's step runner, so one car's throw costs that car only. Defaults to {@link runUnitsDirectly}, which catches nothing
 */
export function diffReplayIncidents(
  state: ReplayRecorderState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  inReplay: boolean,
  emit: ReplayIncidentsEmit,
  runUnit: UnitRunner = runUnitsDirectly,
): void {
  const live = resolveReplayRecordTick(telemetry, inReplay);

  if (live === null) {
    state.replayIncidentsSeeded = false;

    return;
  }

  const { sessionNum, sessionUniqueId, frame } = live;
  const playerCarIdx = resolvePlayerCarIdx(sessionInfo, telemetry);
  const playerCount = readPlayerCount(telemetry);
  const carReadings = readCarReadings(sessionInfo, playerCarIdx);

  const seeding =
    !state.replayIncidentsSeeded ||
    sessionNum !== state.replayIncidentsSessionNum ||
    sessionUniqueId !== state.replayIncidentsSessionUniqueId;
  const prevPlayerCount = state.replayIncidentsLastPlayerCount;
  const prevCarReadings = state.replayIncidentsLastCarReadings;

  // The baselines advance on every eligible tick, the seed included: at once
  // when seeding, after the units otherwise.
  if (seeding) {
    advanceBaselines(state, sessionNum, sessionUniqueId, playerCount, carReadings);

    return;
  }

  // Resolved on the first rise of the tick, not per tick.
  let identity: { subSessionId: number; sessionTimeMs: number } | null = null;
  const publish = (
    unitEmit: ReplayIncidentsEmit,
    carIdx: number,
    delta: number,
    source: "telemetry" | "sessionInfo",
  ): void => {
    const carNumberRaw = getCarNumberRawFromSessionInfo(sessionInfo, carIdx);

    if (carNumberRaw === null) return;

    const sessionTimeS = telemetry.SessionTime;
    identity ??= {
      subSessionId: resolveSubSessionId(sessionInfo),
      sessionTimeMs:
        typeof sessionTimeS === "number" && Number.isFinite(sessionTimeS) ? Math.round(sessionTimeS * 1000) : 0,
    };
    unitEmit({
      event: "replay.incident",
      data: {
        subSessionId: identity.subSessionId,
        sessionNum,
        sessionUniqueId,
        carIdx,
        carNumberRaw,
        frame,
        sessionTimeMs: identity.sessionTimeMs,
        delta,
        source,
      },
    });
  };

  // A unit that throws keeps its car's previous baseline, so the rise is read again next tick.
  let nextPlayerCount = playerCount;

  if (playerCarIdx !== null && playerCount !== null && prevPlayerCount !== null && playerCount > prevPlayerCount) {
    const delta = playerCount - prevPlayerCount;

    if (!runUnit(emit, (unitEmit: ReplayIncidentsEmit) => publish(unitEmit, playerCarIdx, delta, "telemetry"))) {
      nextPlayerCount = prevPlayerCount;
    }
  }

  // The car the unit below reads, set by the loop: one closure per tick rather
  // than one per car.
  let carIdx = 0;
  const car = (unitEmit: ReplayIncidentsEmit): void => {
    const cur: ReplayIncidentCarReading | undefined = carReadings[carIdx];
    // A slot the previous tick's roster did not hold has no baseline, and
    // nor does one another driver or another car held.
    const prev: ReplayIncidentCarReading | undefined = prevCarReadings[carIdx];

    if (cur === undefined || prev === undefined || !sameIdentity(cur, prev)) return;

    if (prev.count < 0 || cur.count <= prev.count) return;

    publish(unitEmit, carIdx, cur.count - prev.count, "sessionInfo");
  };
  // The readings to keep: the roster's own array, or a copy of it once a car
  // has to keep its previous reading (the memoised array is never mutated).
  let nextCarReadings: ReplayIncidentCarReading[] | null = null;

  for (carIdx = 0; carIdx < carReadings.length; carIdx++) {
    if (runUnit(emit, car)) continue;

    // A unit only throws past a rise, which needs a previous reading.
    const held = prevCarReadings[carIdx];

    if (held === undefined) continue;

    nextCarReadings ??= carReadings.slice();
    nextCarReadings[carIdx] = held;
  }

  advanceBaselines(state, sessionNum, sessionUniqueId, nextPlayerCount, nextCarReadings ?? carReadings);
}

function advanceBaselines(
  state: ReplayRecorderState,
  sessionNum: number,
  sessionUniqueId: number,
  playerCount: number | null,
  carReadings: readonly ReplayIncidentCarReading[],
): void {
  state.replayIncidentsSeeded = true;
  state.replayIncidentsSessionNum = sessionNum;
  state.replayIncidentsSessionUniqueId = sessionUniqueId;
  state.replayIncidentsLastPlayerCount = playerCount;
  state.replayIncidentsLastCarReadings = carReadings;
}
