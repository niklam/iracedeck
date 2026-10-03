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
 * **The empty stop (issue #1180).** With no service queued the stop never
 * reaches Complete, so the driver, waiting for the release, would hear
 * nothing. The status cannot tell that stop apart: one capture shows a single
 * tick of InProgress, two others never report InProgress at all. What all
 * three show is a `PitstopActive` pulse of two to four frames on the
 * pit-stall surface, where a real stop holds the flag up for the whole
 * service. So the diff tracks `PitstopActive` on every tick
 * (`trackEmptyStopPulse`) and emits `pitService.stopEmpty` when a pulse it
 * saw rise falls within `PIT_STATUS_EMPTY_STOP_MAX_MS` on the InPitStall
 * surface. Only that captured shape: a longer pulse (an abandoned stop, every
 * service cleared mid-stop, a penalty hold, a driver swap) stays silent,
 * because a "go" there could be false. `statusChanged` keeps mirroring the
 * sim — InProgress is emitted on the tick it appears, and every `* → None`
 * is absorbed; keeping an empty stop from saying "Pit stop in progress." is
 * the in-progress contract's job (it waits a quarter-second and re-checks the
 * live status), not this diff's.
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
 * The longest `PitstopActive` pulse that still counts as an empty stop when
 * it falls (issue #1180), exclusive. With nothing queued the flag is up for
 * two to four frames (33–67 ms in the 2026-09-19 and 2026-10-03 captures),
 * while a real stop holds it for the whole service (20 s in the 2026-09-19
 * capture). A pulse this long or longer is one of the uncaptured cases — an
 * abandoned stop, every service cleared mid-stop, a penalty hold, a driver
 * swap — where a release could be false, so it stays silent.
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
 * Seed the baselines and clear the repeat cycle and the rest clock — used on
 * the first tick and while off-track. A `PitstopActive` already up at the seed
 * has no known start, so its fall can never count as the short empty-stop
 * pulse.
 */
function seed(state: TranslatorState, status: number, pitstopActive: boolean): void {
  state.pitStatusInitialized = true;
  state.lastPitSvStatus = status;
  state.pitStatusRepeatDueAt = 0;
  state.pitStatusRestSince = 0;
  state.lastPitstopActive = pitstopActive;
  state.pitstopActiveSince = 0;
}

/**
 * Advance the at-rest clock from this tick's speed. The car is moving when
 * its speed, signed (a reverse crawl counts), is above
 * {@link PIT_STATUS_MOVEMENT_SPEED_MPS}; missing `Speed` counts as stationary
 * — a callout must never be suppressed by absent telemetry (#574).
 */
function updateRestTracking(state: TranslatorState, telemetry: TelemetryData, now: number): void {
  if (Math.abs(telemetry.Speed ?? 0) > PIT_STATUS_MOVEMENT_SPEED_MPS) {
    state.pitStatusRestSince = 0;
  } else if (state.pitStatusRestSince === 0) {
    state.pitStatusRestSince = now;
  }
}

function isAtRest(state: TranslatorState, now: number): boolean {
  return state.pitStatusRestSince !== 0 && now - state.pitStatusRestSince >= PIT_STATUS_REST_SETTLE_MS;
}

/**
 * Track the `PitstopActive` pulse and release an empty stop on its fall
 * (issue #1180). Runs on every tick after the seed, before the status logic
 * and its early returns: in the 2026-09-19 capture the pulse rises on the
 * very tick the status drops back to None.
 *
 * The pulse counts when this diff saw it rise (a seed while it is up leaves
 * the start unknown), it lasted less than {@link PIT_STATUS_EMPTY_STOP_MAX_MS},
 * and the car is on the pit-stall surface at the fall. The surface, not
 * `PlayerCarInPitStall`, which was still false at every captured fall. No
 * speed gate: the car is still settling at the fall (0.050 m/s in one
 * capture), and the duration bound already excludes a stop the driver drives
 * away from. Missing surface qualifies (#574); missing `PitstopActive` reads
 * as down, so no pulse and no release.
 */
function trackEmptyStopPulse(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const active = telemetry.PitstopActive ?? false;

  if (active === state.lastPitstopActive) return;

  state.lastPitstopActive = active;

  if (active) {
    state.pitstopActiveSince = now;

    return;
  }

  const since = state.pitstopActiveSince;

  state.pitstopActiveSince = 0;

  if (since === 0 || now - since >= PIT_STATUS_EMPTY_STOP_MAX_MS) return;

  const surface = telemetry.PlayerTrackSurface;

  if (surface !== undefined && surface !== TrkLoc.InPitStall) return;

  // The stop ended with nothing done while the car sat in its box: release
  // the driver.
  emit({ event: "pitService.stopEmpty", data: {} });
}

export function diffPitStatus(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const status = telemetry.PlayerCarPitSvStatus ?? PitSvStatus.None;
  const isOnTrack = telemetry.IsOnTrack ?? false;

  if (!state.pitStatusInitialized || !isOnTrack) {
    seed(state, status, telemetry.PitstopActive ?? false);

    return;
  }

  trackEmptyStopPulse(state, telemetry, now, emit);
  updateRestTracking(state, telemetry, now);

  if (status !== state.lastPitSvStatus) {
    // Every close to None — the silent idle state — is absorbed; the baseline
    // still advances below so the next genuine transition fires correctly.
    // An empty stop's release comes from the pulse above, not from here.
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
