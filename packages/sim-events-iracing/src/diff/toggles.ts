/**
 * Pit service and car control toggle transitions.
 *
 * Emits:
 *   - pitService.toggled { service, on } — when Fuel / WindshieldTearoff /
 *     FastRepair bits in PitSvFlags flip. The fuel bit is the exception: a
 *     flip settling while auto-fuel is armed, or inside an auto-fuel switch's
 *     own window, publishes NOTHING (issue #474) — see the next line.
 *   - pitService.autoFuelSwitched { on, refuel } — when auto-fuel
 *     (`dpFuelAutoFillActive`) is switched on or off, debounced like the
 *     bits, with `refuel` the fuel request the change leaves behind. Silent
 *     from pit road onward, where the stop itself consumes auto-fuel.
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

import type { ServiceDebounceState, TranslatorState } from "../state.js";
import type { EmitFn, PendingEvent } from "./types.js";

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
 * Debounce one boolean signal against its baseline. Returns the new baseline
 * value. Mutates the debounce state in place.
 *
 * `settledEvent` names what a settled change publishes, given the settled
 * value. It is called on the settling tick only, and may return `null` for a
 * change that is deliberately silent — the baseline advances either way,
 * which is what keeps a silent flip from being re-announced later (issue
 * #474 relies on both halves of that).
 */
function diffDebouncedFlag(
  settledEvent: (on: boolean) => PendingEvent | null,
  current: boolean,
  baseline: boolean,
  debounce: ServiceDebounceState,
  now: number,
  emit: EmitFn,
): boolean {
  if (current === baseline) {
    debounce.pendingAt = 0;
    debounce.lastSeen = current;

    return baseline;
  }

  if (debounce.pendingAt === 0 || current !== debounce.lastSeen) {
    debounce.pendingAt = now;
    debounce.lastSeen = current;
  }

  if (now - debounce.pendingAt >= PIT_SERVICE_DEBOUNCE_MS) {
    const event = settledEvent(current);

    if (event !== null) emit(event);

    debounce.pendingAt = 0;

    return current;
  }

  return baseline;
}

/**
 * Debounce a single pit-service bit out of `PitSvFlags`. Returns the new
 * baseline value (true if set, false if cleared) — caller folds it back into
 * the persisted baseline-flags integer.
 */
function diffPitServiceBit(
  settledEvent: (on: boolean) => PendingEvent | null,
  flagMask: number,
  pitSvFlags: number,
  baselineFlags: number,
  debounce: ServiceDebounceState,
  now: number,
  emit: EmitFn,
): boolean {
  return diffDebouncedFlag(
    settledEvent,
    (pitSvFlags & flagMask) !== 0,
    (baselineFlags & flagMask) !== 0,
    debounce,
    now,
    emit,
  );
}

/** A settled windshield / fast-repair flip is always the driver's toggle. */
function toggledEvent(service: PitServiceKind): (on: boolean) => PendingEvent {
  return (on) => ({ event: "pitService.toggled", data: { service, on } });
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
 * What a settled fuel flip publishes (issue #474) — the driver's toggle, or
 * nothing at all when `silent` says the flip belongs to auto-fuel's story
 * rather than its own.
 *
 * iRacing's auto-fuel owns the `FuelFill` bit and writes it itself, and
 * telemetry carries no source for a flip: while auto-fuel is armed, the sim's
 * own write and the driver's press are the same bit moving. Announcing one as
 * a request the driver made is the phantom confirmation #474 was filed about,
 * so nothing at all is said for a flip that settles while armed. What the
 * driver hears instead is auto-fuel being switched on or off, carrying the
 * fuel request it leaves behind (`pitService.autoFuelSwitched`).
 *
 * The baseline still advances through the silence, so the bit is never
 * re-announced later as though it had just moved.
 */
function fuelSettledEvent(on: boolean, silent: boolean): PendingEvent | null {
  return silent ? null : { event: "pitService.toggled", data: { service: "fuel", on } };
}

/**
 * What a settled auto-fuel switch publishes (issue #474). `refuel` is the
 * fuel request as it stands when the change settles: auto-fuel having
 * fuelling switched on leaves the ordinary fuel request set when it goes off,
 * so the two facts belong in one line.
 */
function autoFuelSwitchedEvent(on: boolean, refuel: boolean): PendingEvent {
  return { event: "pitService.autoFuelSwitched", data: { on, refuel } };
}

/**
 * Re-seed the auto-fuel baseline to what telemetry reads now, dropping any
 * pending switch. A change absorbed here is never announced — not now and not
 * on the tick the gate lifts.
 */
function seedAutoFuel(state: TranslatorState, autoFuelArmed: boolean): void {
  state.autoFuelBaseline = autoFuelArmed;
  state.autoFuelDebounce.pendingAt = 0;
  state.autoFuelDebounce.lastSeen = autoFuelArmed;
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
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const pitSvCompound = telemetry.PitSvTireCompound ?? 0;
  const currTireBits = pitSvFlags & TIRE_FLAGS_MASK;
  const autoFuelArmed = isAutoFuelActive(telemetry);
  const fuelRequested = (pitSvFlags & PitSvFlags.FuelFill) !== 0;

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
    state.fuelDebounce = { pendingAt: 0, lastSeen: (pitSvFlags & PitSvFlags.FuelFill) !== 0 };
    state.windshieldDebounce = {
      pendingAt: 0,
      lastSeen: (pitSvFlags & PitSvFlags.WindshieldTearoff) !== 0,
    };
    state.fastRepairDebounce = { pendingAt: 0, lastSeen: (pitSvFlags & PitSvFlags.FastRepair) !== 0 };
    seedAutoFuel(state, autoFuelArmed);

    return;
  }

  // ── Auto-fuel switched on / off (issue #474) ──────────────────────────
  // Runs BEFORE the fuel bit, which asks whether a switch is in flight.
  //
  // Silent from pit road onward, on top of the seeding rules above: the stop
  // CONSUMES auto-fuel, so the flag drops 1 → 0 as the stop begins (twice in
  // the capture, both on pit road, ~200 ms before the in-stall flag). That is
  // the sim's bookkeeping, not a decision anyone made. Re-seeding on every
  // pit-road tick is what keeps it silent rather than merely deferred —
  // otherwise leaving pit road would fire the drop the stop caused. Auto-fuel
  // re-arming at pit APPROACH still announces: `OnPitRoad` is false there.
  let autoFuelJustSwitched = false;

  if (onPitRoad) {
    seedAutoFuel(state, autoFuelArmed);
  } else {
    state.autoFuelBaseline = diffDebouncedFlag(
      (on) => {
        autoFuelJustSwitched = true;

        // `refuel` reads the bit live rather than the debounced baseline: the
        // capture's takeover clears the request in the very tick it arms
        // auto-fuel, and the answer to "what are we left with" is what the
        // request says once the change has settled.
        return autoFuelSwitchedEvent(on, fuelRequested);
      },
      autoFuelArmed,
      state.autoFuelBaseline,
      state.autoFuelDebounce,
      now,
      emit,
    );
  }

  // A fuel flip that settles while auto-fuel is armed says nothing, and
  // neither does one settling inside a switch's own window — that flip IS the
  // switch's consequence, and `refuel` already carries it. Sharing
  // `PIT_SERVICE_DEBOUNCE_MS` between the two is what makes "inside the
  // window" the same span for both, so the pair can never split one change
  // into two lines.
  const fuelFlipIsSilent = autoFuelArmed || autoFuelJustSwitched || state.autoFuelDebounce.pendingAt !== 0;

  // ── Pit service (fuel / windshield / fast-repair, debounced) ───────────
  const nextBaselineFuel = diffPitServiceBit(
    (on) => fuelSettledEvent(on, fuelFlipIsSilent),
    PitSvFlags.FuelFill,
    pitSvFlags,
    state.lastPitSvFlags,
    state.fuelDebounce,
    now,
    emit,
  );
  const nextBaselineWindshield = diffPitServiceBit(
    toggledEvent("windshield"),
    PitSvFlags.WindshieldTearoff,
    pitSvFlags,
    state.lastPitSvFlags,
    state.windshieldDebounce,
    now,
    emit,
  );
  const nextBaselineFastRepair = diffPitServiceBit(
    toggledEvent("fastRepair"),
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
