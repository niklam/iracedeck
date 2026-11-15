/**
 * The pit limiter switched on or off (issue #1272).
 *
 * Emits:
 *   - carControl.limiterToggled { on } — on every change of the
 *     `EngineWarnings.PitSpeedLimiter` bit (`isPitLimiterEngaged`), on track,
 *     on pit road and in the pit stall. No debounce: a wheel-button limiter
 *     flips in one tick, so on → off → on is two `on: true`, which is true.
 *
 * Silent — the baseline follows the bit without a word — on:
 *   - the first tick after the state is created or wiped (connect, session
 *     change, a replay glance): a limiter already on is not an engagement the
 *     translator saw;
 *   - every tick with `IsOnTrack` false (out of the car): there is no edge when
 *     the car comes back;
 *   - every tick with `PitstopActive` true, wherever the car is. The old stall
 *     guard's claim that the limiter is noisy during service was never
 *     measured, so the guard takes it as stated and silences exactly the
 *     service window rather than the whole stall;
 *   - every tick the player's car is out of the world (`PlayerTrackSurface`
 *     `NotInWorld`). A tow or a reset keeps `IsOnTrack` true and passes one
 *     such tick before landing in the stall (captures
 *     `tire-temps-tow-20261011.json` ticks 18→19,
 *     `tire-temps-stops-20261011.json` ticks 27→28), and getting in the car
 *     does the same; whether iRacing moves the bit there is unknown, and the
 *     silence makes it not matter;
 *   - for {@link LIMITER_SERVICE_SETTLE_MS} after either of the last two ends,
 *     counted from the tick that clears it, so a bit landing on the tick
 *     service ends or the car is back is never an engagement.
 *
 * Only positive reads silence: a missing `PitstopActive` or
 * `PlayerTrackSurface` is not a hold.
 *
 * The limiter left `diffToggles`' stall seed for this: the seed silences every
 * toggle in the stall, so a press in the box could never publish, while the
 * pit-service bits it exists for keep it. DRS and P2P stay there too.
 * Decision record: `docs/superpowers/specs/2026-09-27-issue-1272-limiter-on-beep.md`.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { isPitLimiterEngaged, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { LimiterToggleState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * How long the limiter baseline keeps following the bit silently after pit
 * service or an out-of-world tick ends, counted from the tick that clears it.
 * Absorbs a bit change landing as service ends or the car lands in its stall;
 * a press inside it is silent, which costs nothing because the driver is still
 * waiting for the crew or has just been placed.
 *
 * @internal Exported for testing.
 */
export const LIMITER_SERVICE_SETTLE_MS = 500;

/** The events {@link diffLimiterToggle} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const LIMITER_TOGGLE_EVENTS = ["carControl.limiterToggled"] as const satisfies readonly SimEventName[];

/** Step the limiter's on / off edge for one tick. Writes its slice last (#1559). */
export function diffLimiterToggle(
  limiter: LimiterToggleState,
  telemetry: TelemetryData,
  now: number,
  emit: EmitFn<(typeof LIMITER_TOGGLE_EVENTS)[number]>,
): void {
  const engaged = isPitLimiterEngaged(telemetry);
  const isOnTrack = telemetry.IsOnTrack === true;
  const held = telemetry.PitstopActive === true || telemetry.PlayerTrackSurface === TrkLoc.NotInWorld;
  // Re-armed on every held tick and on the tick that clears the hold, so the
  // tail always starts at that tick, however far apart the ticks are.
  const settleUntil = held || limiter.held ? now + LIMITER_SERVICE_SETTLE_MS : limiter.settleUntil;
  const silent = !limiter.initialized || !isOnTrack || held || now < settleUntil;

  if (!silent && engaged !== limiter.active) {
    emit({ event: "carControl.limiterToggled", data: { on: engaged } });
  }

  limiter.initialized = true;
  limiter.active = engaged;
  limiter.held = held;
  limiter.settleUntil = settleUntil;
}
