/**
 * Pit-service status transitions (issue #479) and the positioning-error
 * repeat cadence (issue #951).
 *
 * Emits `pitService.statusChanged { from, to }` whenever
 * `PlayerCarPitSvStatus` changes — covering "in progress" / "complete" /
 * the four positioning errors / "can't fix that". Closing transitions
 * (`* → None`) are silently absorbed: the engineer doesn't announce the
 * idle state. The translator suppresses the emit but still advances the
 * baseline, so the next non-`None` transition re-fires correctly.
 *
 * Seeded silently only on first tick or while off-track. We deliberately
 * do NOT seed on `PlayerCarInPitStall: true` — every one of the eight
 * callouts (InProgress, Complete, the four positioning errors, BadAngle,
 * CantFixThat) only ever fires while parked in the stall. Live-captured
 * telemetry (`master/local/telemetry-snapshot-20260505-192236.json`)
 * shows `IsOnTrack: true, PlayerCarInPitStall: true,
 * PlayerCarPitSvStatus: 1` (InProgress) during an active stop — re-seeding
 * here would silence the entire feature.
 *
 * Compare with `diffToggles`, which DOES re-seed in-stall: the toggle
 * bits flip as the crew completes each fuel/tire task — those are
 * servicing artifacts, not user intent. `PlayerCarPitSvStatus` is
 * precisely the in-stall signal we want narrated.
 *
 * **Positioning repeat (issue #951).** iRacing reports a positioning error
 * ONCE and then leaves the status latched, so a driver who overshoots, backs
 * up, and stops still short of the box sits unserved in silence — neither
 * iRacing's own spotter nor a transition-only diff says anything more. While
 * one of the five positioning errors stays latched, this diff re-emits a
 * dedicated `pitService.positioningRepeat { status }` on a fixed cadence so
 * the audio layer can nag with a terse correction line. There is deliberately
 * NO cooldown — the repeat is the whole point, and it stops the moment the
 * error resolves or changes.
 *
 * The repeat is HELD while the car is moving: the driver is already
 * correcting, and talking over them helps nobody. Corrections happen at a
 * crawl over distances of inches, so the movement threshold is tiny and
 * paired with an asymmetric debounce (see `PIT_STATUS_REST_SETTLE_MS`).
 *
 * `InProgress` / `Complete` / `CantFixThat` never repeat: they state a fact,
 * not an uncorrected error.
 */
import { PitSvStatus, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * How long a latched positioning error waits between repeats. Short enough
 * that a driver parked in the wrong spot learns about it before the stop is
 * wasted, long enough for the terse nag line to have finished playing.
 */
export const PIT_STATUS_REPEAT_INTERVAL_MS = 2000;

/**
 * Speed (m/s) at or below which the car counts as stationary — ~0.18 km/h,
 * roughly two inches per second. Box corrections happen at a crawl over
 * distances of inches, so anything a driver would recognise as "moving the
 * car" has to land above this.
 */
export const PIT_STATUS_MOVEMENT_SPEED_MPS = 0.05;

/**
 * How long the car must stay below {@link PIT_STATUS_MOVEMENT_SPEED_MPS}
 * before it counts as at rest again.
 *
 * The debounce is deliberately ASYMMETRIC: a single sample above the
 * threshold marks the car moving immediately, while returning to "at rest"
 * takes the full window. Noise therefore costs at most a slightly delayed
 * nag, whereas the failure that actually matters — nagging while the driver
 * is mid-correction — needs sustained evidence of stillness.
 */
export const PIT_STATUS_REST_SETTLE_MS = 500;

/**
 * The statuses that describe an uncorrected parking error, and so keep
 * repeating until the driver fixes them or iRacing reports a different one.
 */
const POSITIONING_ERRORS: ReadonlySet<number> = new Set<number>([
  PitSvStatus.TooFarLeft,
  PitSvStatus.TooFarRight,
  PitSvStatus.TooFarForward,
  PitSvStatus.TooFarBack,
  PitSvStatus.BadAngle,
]);

function isPositioningError(status: number): boolean {
  return POSITIONING_ERRORS.has(status);
}

/** Clear the repeat cycle and the rest clock — used on seed / off-track. */
function disarmRepeat(state: TranslatorState): void {
  state.pitStatusRepeatDueAt = 0;
  state.pitStatusRestSince = 0;
}

/**
 * Advance the at-rest clock from this tick's speed. Missing `Speed` counts as
 * stationary — a callout must never be suppressed by absent telemetry.
 */
function updateRestTracking(state: TranslatorState, telemetry: TelemetryData, now: number): void {
  const speed = Math.abs(telemetry.Speed ?? 0);

  if (speed > PIT_STATUS_MOVEMENT_SPEED_MPS) {
    state.pitStatusRestSince = 0;
  } else if (state.pitStatusRestSince === 0) {
    state.pitStatusRestSince = now;
  }
}

function isAtRest(state: TranslatorState, now: number): boolean {
  return state.pitStatusRestSince !== 0 && now - state.pitStatusRestSince >= PIT_STATUS_REST_SETTLE_MS;
}

export function diffPitStatus(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const status = telemetry.PlayerCarPitSvStatus ?? PitSvStatus.None;
  const isOnTrack = telemetry.IsOnTrack ?? false;

  if (!state.pitStatusInitialized || !isOnTrack) {
    state.pitStatusInitialized = true;
    state.lastPitSvStatus = status;
    disarmRepeat(state);

    return;
  }

  updateRestTracking(state, telemetry, now);

  if (status !== state.lastPitSvStatus) {
    // Suppress the closing transition (any → None) — the silent idle state
    // shouldn't surface as a callout. Advance the baseline so the next
    // genuine transition fires correctly.
    if (status !== PitSvStatus.None) {
      emit({ event: "pitService.statusChanged", data: { from: state.lastPitSvStatus, to: status } });
    }

    state.lastPitSvStatus = status;
    // A transition starts the cycle over: the new status speaks its own full
    // call through the path above, and its first repeat is a whole interval
    // away. Anything that isn't a positioning error simply disarms.
    state.pitStatusRepeatDueAt = isPositioningError(status) ? now + PIT_STATUS_REPEAT_INTERVAL_MS : 0;

    return;
  }

  if (state.pitStatusRepeatDueAt === 0 || now < state.pitStatusRepeatDueAt || !isAtRest(state, now)) return;

  emit({ event: "pitService.positioningRepeat", data: { status } });
  // Re-arm from NOW, not from the missed due time: a repeat held back through
  // a long correction must not drain its backlog as a burst on the tick the
  // car finally settles.
  state.pitStatusRepeatDueAt = now + PIT_STATUS_REPEAT_INTERVAL_MS;
}
