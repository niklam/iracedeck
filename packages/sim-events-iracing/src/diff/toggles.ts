/**
 * Pit service and car control toggle transitions.
 *
 * Emits:
 *   - pitService.toggled { service, on } — when Fuel / WindshieldTearoff /
 *     FastRepair bits in PitSvFlags flip. For fuel, only a flip made while
 *     auto-fuel is NOT armed; see the next line.
 *   - pitService.autoFuelChanged { refuel } — INSTEAD of the fuel toggle, for
 *     a settled FuelFill flip made while auto-fuel is armed
 *     (`dpFuelAutoFillActive`, issue #474). Exactly one of the two per
 *     settled fuel flip, never both. Arming or disarming auto-fuel with the
 *     fuel bit unchanged emits nothing.
 *   - tireService.changed { added, removed, current } — when tire service
 *     bits flip. `current` is the post-change set so consumers can decide
 *     based on the resulting state (vs. trying to reconstruct it from the
 *     deltas, which fails for mid-transition events like a side-switch
 *     emitted as two ticks).
 *   - tireService.compoundChanged { from, to } — when PitSvTireCompound
 *     changes. iRacing flips compound atomically and force-sets all four
 *     tire bits in the same tick; we suppress the cascading
 *     tireService.changed for that transition so the compound voice line
 *     is the single canonical confirmation (see the compound block).
 *   - carControl.drsToggled / p2pToggled / limiterToggled { on } — on
 *     respective bit changes.
 *
 * Seeded on first tick (or when IsOnTrack is false) to avoid false
 * transitions on connect / garage returns.
 */
import type { PitServiceKind } from "@iracedeck/event-bus";
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { FuelDebounceState, ServiceDebounceState, TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

// Tire flag → human-readable name (matches pit-crew's TIRE_SHORT domain)
const TIRE_FLAGS: ReadonlyArray<{ flag: number; name: string }> = [
  { flag: PitSvFlags.LFTireChange, name: "LF" },
  { flag: PitSvFlags.RFTireChange, name: "RF" },
  { flag: PitSvFlags.LRTireChange, name: "LR" },
  { flag: PitSvFlags.RRTireChange, name: "RR" },
];

const TIRE_FLAGS_MASK =
  PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

/**
 * Debounce window for tire-set changes. iRacing's side / fronts / rears /
 * all buttons emit multi-tick state transitions (typically a clear-all
 * intermediate before the final selection). We wait for the tire bits to
 * stay stable for this long before computing the delta against the last
 * emitted baseline. 500 ms is comfortably longer than the observed
 * iRacing settling time and short enough to be imperceptible vs the
 * ~3 s engineer voice line that follows.
 *
 * @internal Exported for testing.
 */
export const TIRE_DEBOUNCE_MS = 500;

/**
 * Debounce window for single-bit pit-service toggles (fuel, windshield,
 * fast-repair). Same idea as the tire debounce: collapse the user's rapid
 * intent oscillations (accidental tap-tap, mind-changing within a second)
 * into a single emit reflecting the settled state. Shorter than the tire
 * window because there's no multi-tick intermediate to ride out — only
 * the user's settling time.
 *
 * @internal Exported for testing.
 */
export const PIT_SERVICE_DEBOUNCE_MS = 300;

/**
 * What one tick did to a single pit-service bit's debounce. The debounce
 * itself names no event: each caller decides what a settled flip is called,
 * which is what lets the fuel bit attribute its flips (issue #474) without
 * the windshield and fast-repair bits carrying any of that.
 */
type DebounceStep = {
  /**
   * `stable` — the bit sits at its baseline (anything pending was reverted
   * and cleared); `pending` — a flip is inside the window; `settled` — a
   * flip held for the whole window and the baseline advanced to it.
   */
  phase: "stable" | "pending" | "settled";
  /** This tick (re)started the pending window. Never true when `stable`. */
  armed: boolean;
  /** The baseline after this tick: the settled value on a settle, unchanged otherwise. */
  baseline: boolean;
};

/**
 * Debounce a single pit-service bit. Mutates the per-service debounce state
 * in place; the returned `baseline` is what the caller folds back into the
 * persisted baseline-flags integer.
 */
function stepServiceDebounce(
  flagMask: number,
  pitSvFlags: number,
  baselineFlags: number,
  debounce: ServiceDebounceState,
  now: number,
): DebounceStep {
  const current = (pitSvFlags & flagMask) !== 0;
  const baseline = (baselineFlags & flagMask) !== 0;

  if (current === baseline) {
    debounce.pendingAt = 0;
    debounce.lastSeen = current;

    return { phase: "stable", armed: false, baseline };
  }

  let armed = false;

  if (debounce.pendingAt === 0 || current !== debounce.lastSeen) {
    debounce.pendingAt = now;
    debounce.lastSeen = current;
    armed = true;
  }

  if (now - debounce.pendingAt >= PIT_SERVICE_DEBOUNCE_MS) {
    debounce.pendingAt = 0;

    return { phase: "settled", armed, baseline: current };
  }

  return { phase: "pending", armed, baseline };
}

/**
 * Debounce a single pit-service bit and announce a settled flip as the
 * driver's toggle. Returns the new baseline value.
 */
function diffPitServiceBit(
  service: PitServiceKind,
  flagMask: number,
  pitSvFlags: number,
  baselineFlags: number,
  debounce: ServiceDebounceState,
  now: number,
  emit: EmitFn,
): boolean {
  const step = stepServiceDebounce(flagMask, pitSvFlags, baselineFlags, debounce, now);

  if (step.phase === "settled") {
    emit({ event: "pitService.toggled", data: { service, on: step.baseline } });
  }

  return step.baseline;
}

/**
 * Whether auto-fuel is armed for the next stop (`dpFuelAutoFillActive`,
 * "pitstop auto fill fuel next stop flag"). deck-core's `isAutofuelActive`
 * rule, inlined because this package does not depend on deck-core: an absent
 * field reads as not active, any non-zero value as active.
 */
function isAutoFuelActive(telemetry: TelemetryData): boolean {
  return (telemetry.dpFuelAutoFillActive ?? 0) !== 0;
}

/**
 * The fuel bit: the same debounce, plus attribution (issue #474). iRacing's
 * auto-fuel owns the `FuelFill` bit and flips it on its own; telemetry
 * carries no source for a flip, only whether auto-fuel is armed, so a flip is
 * the sim's when `dpFuelAutoFillActive` read active on the tick the pending
 * flip was armed (latched in `debounce.autoFuelArmed`, OR-ed across re-arms)
 * OR on the tick it settles. Either one is enough: a false "auto" on a manual
 * press only changes the wording of a line the driver expected, while a
 * false "manual" on a sim flip is the repeated phantom confirmation #474 was
 * filed about — so ties fail towards auto. That also makes a press made while
 * auto-fuel is armed an auto flip: the two cannot be told apart.
 *
 * Exactly one event per settled flip — `pitService.autoFuelChanged` or
 * `pitService.toggled { service: "fuel" }` — and the baseline advances the
 * same way for both. Returns the new baseline value.
 */
function diffFuelBit(
  pitSvFlags: number,
  baselineFlags: number,
  debounce: FuelDebounceState,
  autoFuelActive: boolean,
  now: number,
  emit: EmitFn,
): boolean {
  const step = stepServiceDebounce(PitSvFlags.FuelFill, pitSvFlags, baselineFlags, debounce, now);

  if (step.phase === "stable") {
    // Nothing pending (or the pending flip reverted): the latch belonged to
    // that episode and must not attribute the next one.
    debounce.autoFuelArmed = false;

    return step.baseline;
  }

  if (step.armed && autoFuelActive) debounce.autoFuelArmed = true;

  if (step.phase === "settled") {
    const auto = debounce.autoFuelArmed || autoFuelActive;
    debounce.autoFuelArmed = false;

    if (auto) {
      emit({ event: "pitService.autoFuelChanged", data: { refuel: step.baseline } });
    } else {
      emit({ event: "pitService.toggled", data: { service: "fuel", on: step.baseline } });
    }
  }

  return step.baseline;
}

function tireSet(flags: number): Set<string> {
  const s = new Set<string>();

  for (const { flag, name } of TIRE_FLAGS) {
    if ((flags & flag) !== 0) s.add(name);
  }

  return s;
}

export function diffToggles(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const pitSvFlags = telemetry.PitSvFlags ?? 0;
  const limiter = ((telemetry.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
  const p2p = telemetry.P2P_Status === true;
  const drs = (telemetry.DRS_Status ?? 0) > 0;
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const inPitStall = telemetry.PlayerCarInPitStall ?? false;
  const pitSvCompound = telemetry.PitSvTireCompound ?? 0;
  const currTireBits = pitSvFlags & TIRE_FLAGS_MASK;

  // Seed silently on first tick, off-track, or while in the pit stall.
  // While the crew is servicing the car, iRacing flips tire/service bits
  // one-by-one as each task completes — those aren't user-intent events
  // and the engineer should stay silent during the stop. We continuously
  // update the baseline so the bits reflect post-service state on stall
  // exit (no spurious "tires off → tires on" cascade when the user
  // departs).
  if (!state.toggleStateInitialized || !isOnTrack || inPitStall) {
    state.toggleStateInitialized = true;
    state.lastPitSvFlags = pitSvFlags;
    state.lastPitSvCompound = pitSvCompound;
    state.lastLimiterActive = limiter;
    state.lastP2PActive = p2p;
    state.lastDrsActive = drs;
    state.lastSeenTireFlags = currTireBits;
    state.lastTireChangeAt = 0;
    // Seeding clears any pending flip, so the auto-fuel latch goes with it.
    state.fuelDebounce = {
      pendingAt: 0,
      lastSeen: (pitSvFlags & PitSvFlags.FuelFill) !== 0,
      autoFuelArmed: false,
    };
    state.windshieldDebounce = {
      pendingAt: 0,
      lastSeen: (pitSvFlags & PitSvFlags.WindshieldTearoff) !== 0,
    };
    state.fastRepairDebounce = { pendingAt: 0, lastSeen: (pitSvFlags & PitSvFlags.FastRepair) !== 0 };

    return;
  }

  // ── Pit service (fuel / windshield / fast-repair, debounced) ───────────
  // Fuel alone is attributed: a flip made while auto-fuel is armed is the
  // sim's (issue #474, see `diffFuelBit`).
  const nextBaselineFuel = diffFuelBit(
    pitSvFlags,
    state.lastPitSvFlags,
    state.fuelDebounce,
    isAutoFuelActive(telemetry),
    now,
    emit,
  );
  const nextBaselineWindshield = diffPitServiceBit(
    "windshield",
    PitSvFlags.WindshieldTearoff,
    pitSvFlags,
    state.lastPitSvFlags,
    state.windshieldDebounce,
    now,
    emit,
  );
  const nextBaselineFastRepair = diffPitServiceBit(
    "fastRepair",
    PitSvFlags.FastRepair,
    pitSvFlags,
    state.lastPitSvFlags,
    state.fastRepairDebounce,
    now,
    emit,
  );

  // ── Tire compound (immediate; no debounce — single discrete value) ─────
  // iRacing flips compound atomically in one tick and force-sets all four
  // tire bits as part of the same operation. Emit the compound event and
  // absorb the cascading tire-set diff so the compound voice line is the
  // single canonical confirmation (otherwise the engineer would also call
  // out "all four tires" 500 ms later).
  //
  // Issue #484: a "clear tires" press also flips the compound bit (iRacing
  // resets compound to the car default as a side-effect of clearing pit
  // service) but with `currTireBits === 0` instead of `TIRE_FLAGS_MASK`.
  // That isn't a user-initiated compound change — it's a consequence of
  // the clear — so emitting "switching to dry" would be misleading and
  // would also suppress the legitimate "tires cleared" callout. Gate the
  // compound emit on the all-four-tires cascade so only genuine user
  // compound flips fire the compound voice line.
  let compoundJustChanged = false;

  if (state.lastPitSvCompound !== pitSvCompound && currTireBits === TIRE_FLAGS_MASK) {
    emit({
      event: "tireService.compoundChanged",
      data: { from: state.lastPitSvCompound, to: pitSvCompound },
    });
    compoundJustChanged = true;
  }

  // ── Tire service (4 tires, debounced) ──────────────────────────────────
  const baselineTireBits = compoundJustChanged ? currTireBits : state.lastPitSvFlags & TIRE_FLAGS_MASK;
  let nextBaselineTireBits = baselineTireBits;

  if (compoundJustChanged) {
    // Realign the debounce to post-compound tire state so the next genuine
    // user toggle is diffed against it, not against the pre-compound bits.
    state.lastSeenTireFlags = currTireBits;
    state.lastTireChangeAt = 0;
  }

  if (currTireBits !== baselineTireBits) {
    // Track when we last *observed* a flag flip to anchor the debounce.
    if (currTireBits !== state.lastSeenTireFlags) {
      state.lastTireChangeAt = now;
      state.lastSeenTireFlags = currTireBits;
    }

    if (state.lastTireChangeAt > 0 && now - state.lastTireChangeAt >= TIRE_DEBOUNCE_MS) {
      const prevTires = tireSet(baselineTireBits);
      const currTires = tireSet(currTireBits);
      const added: string[] = [];
      const removed: string[] = [];

      for (const t of currTires) if (!prevTires.has(t)) added.push(t);

      for (const t of prevTires) if (!currTires.has(t)) removed.push(t);

      if (added.length > 0 || removed.length > 0) {
        emit({
          event: "tireService.changed",
          data: { added, removed, current: [...currTires] },
        });
      }

      nextBaselineTireBits = currTireBits;
      state.lastTireChangeAt = 0;
    }
  } else {
    // Flags match baseline — change was reverted before the debounce fired,
    // or there's nothing new. Either way, clear the pending state.
    state.lastTireChangeAt = 0;
    state.lastSeenTireFlags = currTireBits;
  }

  // ── Car control toggles (immediate — wheel button presses) ─────────────
  if (state.lastDrsActive !== drs) {
    emit({ event: "carControl.drsToggled", data: { on: drs } });
  }

  if (state.lastP2PActive !== p2p) {
    emit({ event: "carControl.p2pToggled", data: { on: p2p } });
  }

  if (state.lastLimiterActive !== limiter) {
    emit({ event: "carControl.limiterToggled", data: { on: limiter } });
  }

  // All pit-service bits (fuel, windshield, fast-repair, 4 tires) advance
  // only when their respective debounce fires. Other bits in PitSvFlags pass
  // through unchanged so any future non-debounced flag stays correct.
  const PIT_SERVICE_BITS_MASK =
    PitSvFlags.FuelFill | PitSvFlags.WindshieldTearoff | PitSvFlags.FastRepair | TIRE_FLAGS_MASK;
  state.lastPitSvFlags =
    (pitSvFlags & ~PIT_SERVICE_BITS_MASK) |
    (nextBaselineFuel ? PitSvFlags.FuelFill : 0) |
    (nextBaselineWindshield ? PitSvFlags.WindshieldTearoff : 0) |
    (nextBaselineFastRepair ? PitSvFlags.FastRepair : 0) |
    nextBaselineTireBits;
  state.lastPitSvCompound = pitSvCompound;
  state.lastLimiterActive = limiter;
  state.lastP2PActive = p2p;
  state.lastDrsActive = drs;
}
