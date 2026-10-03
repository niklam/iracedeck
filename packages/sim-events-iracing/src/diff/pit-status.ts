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
 * waiting for the release, would hear nothing. InProgress → None while the
 * car is stationary on the pit-stall surface emits `pitService.stopEmpty`
 * instead (see `isEmptyStopClose`). And because that one-tick InProgress
 * would otherwise announce "Pit stop in progress." only to be cut off by the
 * release, a transition to InProgress is HELD for
 * `PIT_STATUS_IN_PROGRESS_HOLD_MS` and emitted only if the status is still
 * InProgress when the hold runs out. Any change or re-seed inside the hold
 * drops it; it is never flushed later.
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
 * How long a transition to InProgress is held before it is announced
 * (issue #1180). With nothing queued iRacing reports InProgress for a single
 * tick and drops straight back to None (0.02 s in the 2026-09-19 capture),
 * while a real stop's InProgress lasts seconds (19 s in the same capture).
 * Holding a quarter-second keeps the empty stop from saying "Pit stop in
 * progress." and then being cut off by its release, at a delay nobody hears
 * on a real stop.
 */
export const PIT_STATUS_IN_PROGRESS_HOLD_MS = 250;

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
 * Clear the repeat cycle, the rest clock and any held InProgress — used on
 * seed / off-track. A held InProgress is dropped, never flushed later: a
 * re-seed means the diff no longer knows the transition it was holding.
 */
function disarm(state: TranslatorState): void {
  state.pitStatusRepeatDueAt = 0;
  state.pitStatusRestSince = 0;
  state.pitStatusInProgressDueAt = 0;
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

/**
 * Whether an InProgress → None close is the empty-stop shape: the car is
 * still on the pit-stall surface and stationary on this very tick. The surface,
 * not `PlayerCarInPitStall`, because the latter was still false on the closing
 * tick in the capture. Instantaneous speed, not the settled-rest window: the
 * empty stop had been at rest for under `PIT_STATUS_REST_SETTLE_MS`. A driver
 * pulling away mid-service is moving here, so stays silent — an assumption no
 * capture has confirmed yet (see the spec). Missing telemetry qualifies (#574).
 */
function isEmptyStopClose(telemetry: TelemetryData): boolean {
  const surface = telemetry.PlayerTrackSurface;
  const speed = Math.abs(telemetry.Speed ?? 0);

  return (surface === undefined || surface === TrkLoc.InPitStall) && speed <= PIT_STATUS_MOVEMENT_SPEED_MPS;
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
    const closedFromInProgress = state.lastPitSvStatus === PitSvStatus.InProgress && status === PitSvStatus.None;

    // Any change drops a held InProgress — it never lasted long enough to say.
    state.pitStatusInProgressDueAt = 0;

    if (status === PitSvStatus.InProgress) {
      // Held, not emitted: a one-tick InProgress is the empty stop (#1180).
      state.pitStatusInProgressDueAt = now + PIT_STATUS_IN_PROGRESS_HOLD_MS;
      state.pitStatusInProgressFrom = state.lastPitSvStatus;
    } else if (status !== PitSvStatus.None) {
      emit({ event: "pitService.statusChanged", data: { from: state.lastPitSvStatus, to: status } });
    } else if (closedFromInProgress && isEmptyStopClose(telemetry)) {
      // The stop ended with nothing done while the car sat in its box: release
      // the driver (#1180). Every other close to None — the silent idle
      // state — is absorbed; the baseline still advances below so the next
      // genuine transition fires correctly.
      emit({ event: "pitService.stopEmpty", data: {} });
    }

    state.lastPitSvStatus = status;
    // A transition starts the cycle over: the new status speaks its own full
    // call through the path above, and its first repeat is a whole interval
    // away. Anything that isn't a positioning error simply disarms.
    state.pitStatusRepeatDueAt = isPositioningError(status) ? now + PIT_STATUS_REPEAT_INTERVAL_MS : 0;

    return;
  }

  // The held InProgress has lasted the whole hold: a real stop, so say it.
  // `from` is the status it came from, not InProgress.
  if (state.pitStatusInProgressDueAt !== 0 && now >= state.pitStatusInProgressDueAt) {
    emit({
      event: "pitService.statusChanged",
      data: { from: state.pitStatusInProgressFrom, to: PitSvStatus.InProgress },
    });
    state.pitStatusInProgressDueAt = 0;
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
