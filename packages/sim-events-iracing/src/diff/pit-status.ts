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
 * **The empty stop (issue #1180).** One closing transition is not absorbed:
 * with no service queued iRacing reports InProgress for a single tick and
 * drops straight back to None, never reaching Complete — so the driver,
 * waiting for the release, would hear nothing. An InProgress that lasted
 * under `PIT_STATUS_EMPTY_STOP_MAX_MS` and closes to None while the car is
 * stationary on the pit-stall surface emits `pitService.stopEmpty` instead
 * (see `isEmptyStopClose`). Only that captured shape: a longer InProgress
 * closing to None (an abandoned stop, every service cleared mid-stop, a
 * penalty hold, a driver swap) stays silent, because a "go" there could be
 * false. `statusChanged` keeps mirroring the sim — InProgress is emitted on
 * the tick it appears; keeping an empty stop from saying "Pit stop in
 * progress." is the in-progress contract's job (it waits a quarter-second and
 * re-checks the live status), not this diff's.
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
import { PitSvStatus, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

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
 * The longest InProgress that still counts as an empty stop when it closes
 * to None (issue #1180), exclusive. With nothing queued iRacing reports
 * InProgress for a single tick and drops straight back to None (0.02 s in the
 * 2026-09-19 capture), while a real stop's InProgress lasts seconds (19 s in
 * the same capture). Anything that lasted this long or longer is one of the
 * uncaptured closes — an abandoned stop, every service cleared mid-stop, a
 * penalty hold, a driver swap — where a release could be false, so it stays
 * silent like every other `* → None`.
 */
export const PIT_STATUS_EMPTY_STOP_MAX_MS = 250;

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

/**
 * Clear the repeat cycle, the rest clock and the InProgress start — used on
 * seed / off-track. A status seeded as InProgress has no known start, so its
 * close can never count as the short empty-stop shape.
 */
function disarm(state: TranslatorState): void {
  state.pitStatusRepeatDueAt = 0;
  state.pitStatusRestSince = 0;
  state.pitStatusInProgressSince = 0;
}

/**
 * Whether the car is moving on this tick: its speed, signed (a reverse crawl
 * counts), is above {@link PIT_STATUS_MOVEMENT_SPEED_MPS}. Missing `Speed`
 * counts as stationary — a callout must never be suppressed by absent
 * telemetry (#574).
 */
function isMoving(telemetry: TelemetryData): boolean {
  return Math.abs(telemetry.Speed ?? 0) > PIT_STATUS_MOVEMENT_SPEED_MPS;
}

/** Advance the at-rest clock from this tick's speed. */
function updateRestTracking(state: TranslatorState, telemetry: TelemetryData, now: number): void {
  if (isMoving(telemetry)) {
    state.pitStatusRestSince = 0;
  } else if (state.pitStatusRestSince === 0) {
    state.pitStatusRestSince = now;
  }
}

function isAtRest(state: TranslatorState, now: number): boolean {
  return state.pitStatusRestSince !== 0 && now - state.pitStatusRestSince >= PIT_STATUS_REST_SETTLE_MS;
}

/**
 * Whether an InProgress → None close on this tick is the empty-stop shape
 * (issue #1180): the InProgress began on a tick this diff saw, less than
 * {@link PIT_STATUS_EMPTY_STOP_MAX_MS} ago, and the car is still on the
 * pit-stall surface and stationary. The surface, not `PlayerCarInPitStall`,
 * because the latter was still false on the closing tick in the capture.
 * Instantaneous speed, not the settled-rest window: the empty stop had been
 * at rest for under `PIT_STATUS_REST_SETTLE_MS`. An InProgress whose start is
 * unknown (seeded, or re-seeded mid-stop) never qualifies. Missing surface or
 * speed qualifies (#574).
 */
function isEmptyStopClose(state: TranslatorState, telemetry: TelemetryData, now: number): boolean {
  if (state.pitStatusInProgressSince === 0) return false;

  if (now - state.pitStatusInProgressSince >= PIT_STATUS_EMPTY_STOP_MAX_MS) return false;

  const surface = telemetry.PlayerTrackSurface;

  return (surface === undefined || surface === TrkLoc.InPitStall) && !isMoving(telemetry);
}

export function diffPitStatus(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const status = telemetry.PlayerCarPitSvStatus ?? PitSvStatus.None;
  const isOnTrack = telemetry.IsOnTrack ?? false;

  if (!state.pitStatusInitialized || !isOnTrack) {
    state.pitStatusInitialized = true;
    state.lastPitSvStatus = status;
    disarm(state);

    return;
  }

  updateRestTracking(state, telemetry, now);

  if (status !== state.lastPitSvStatus) {
    if (status !== PitSvStatus.None) {
      emit({ event: "pitService.statusChanged", data: { from: state.lastPitSvStatus, to: status } });
    } else if (state.lastPitSvStatus === PitSvStatus.InProgress && isEmptyStopClose(state, telemetry, now)) {
      // The stop ended with nothing done while the car sat in its box: release
      // the driver (#1180). Every other close to None — the silent idle
      // state — is absorbed; the baseline still advances below so the next
      // genuine transition fires correctly.
      emit({ event: "pitService.stopEmpty", data: {} });
    }

    state.lastPitSvStatus = status;
    // When this InProgress began, for the empty-stop bound; 0 for any other
    // status.
    state.pitStatusInProgressSince = status === PitSvStatus.InProgress ? now : 0;
    // A transition starts the cycle over: the new status speaks its own full
    // call through the path above, and its first repeat is a whole interval
    // away. Anything that isn't a positioning error simply disarms.
    state.pitStatusRepeatDueAt = isPositioningError(status) ? now + PIT_STATUS_REPEAT_INTERVAL_MS : 0;

    return;
  }

  // Only the five positioning errors repeat. Checked explicitly rather than
  // inferred from the arm flag, so no arming site can silently start nagging
  // on `InProgress` / `Complete` / `CantFixThat` — none of which has a
  // scenario, a pool, or a clip.
  if (!isPositioningError(status)) {
    state.pitStatusRepeatDueAt = 0;

    return;
  }

  // A latched error is only actionable while the car is still in the pit
  // lane. Without this, a status that stays latched after the driver gives up
  // and drives out would nag forever wherever the car next comes to rest — a
  // spin, a red flag, an off-track recovery. The gate is `OnPitRoad` and
  // deliberately NOT `PlayerCarInPitStall`: an overshooting car may well read
  // false for the stall, and that is precisely the case this issue exists to
  // fix. Missing telemetry counts as on pit road — a callout must never be
  // suppressed by absent data.
  if (telemetry.OnPitRoad === false) {
    state.pitStatusRepeatDueAt = 0;

    return;
  }

  // LEVEL-armed, not edge-armed. The transition above arms the clock for the
  // normal case, but a diff that gets RE-SEEDED mid-stop has no transition
  // left to arm on — `pitStatusInitialized` resets on a plugin restart (a
  // deck-host auto-update, #870), an SDK reconnect, a one-tick
  // `IsOnTrack: false` blip, and the replay-flip `wipeStateForReplay`, which
  // does not preserve it. Edge-arming alone left the driver parked wrong in
  // permanent silence — the exact failure this issue removes — so a latched
  // error with no armed clock starts one here, a full interval out.
  if (state.pitStatusRepeatDueAt === 0) {
    state.pitStatusRepeatDueAt = now + PIT_STATUS_REPEAT_INTERVAL_MS;

    return;
  }

  if (now < state.pitStatusRepeatDueAt || !isAtRest(state, now)) return;

  emit({ event: "pitService.positioningRepeat", data: { status } });
  // Re-arm from NOW, not from the missed due time: a repeat held back through
  // a long correction must not drain its backlog as a burst on the tick the
  // car finally settles.
  state.pitStatusRepeatDueAt = now + PIT_STATUS_REPEAT_INTERVAL_MS;
}
