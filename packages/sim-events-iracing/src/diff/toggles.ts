/**
 * Pit service and car control toggle transitions.
 *
 * Emits:
 *   - pitService.toggled { service, on } — when Fuel / WindshieldTearoff /
 *     FastRepair bits in PitSvFlags flip.
 *   - tireService.changed { added, removed, current } — when tire service
 *     bits flip. `current` is the post-change set so consumers can decide
 *     based on the resulting state (vs. trying to reconstruct it from the
 *     deltas, which fails for mid-transition events like a side-switch
 *     emitted as two ticks).
 *   - carControl.drsToggled / p2pToggled / limiterToggled { on } — on
 *     respective bit changes.
 *
 * Seeded on first tick (or when IsOnTrack is false) to avoid false
 * transitions on connect / garage returns.
 */
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
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
  const pitSvCompound = telemetry.PitSvTireCompound ?? 0;
  const currTireBits = pitSvFlags & TIRE_FLAGS_MASK;

  // First tick, or off-track — capture state silently.
  if (!state.toggleStateInitialized || !isOnTrack) {
    state.toggleStateInitialized = true;
    state.lastPitSvFlags = pitSvFlags;
    state.lastPitSvCompound = pitSvCompound;
    state.lastLimiterActive = limiter;
    state.lastP2PActive = p2p;
    state.lastDrsActive = drs;
    state.lastSeenTireFlags = currTireBits;
    state.lastTireChangeAt = 0;

    return;
  }

  // ── Pit service (fuel / windshield / fast-repair) ──────────────────────
  const prevFuel = (state.lastPitSvFlags & PitSvFlags.FuelFill) !== 0;
  const currFuel = (pitSvFlags & PitSvFlags.FuelFill) !== 0;

  if (prevFuel !== currFuel) {
    emit({ event: "pitService.toggled", data: { service: "fuel", on: currFuel } });
  }

  const prevWindshield = (state.lastPitSvFlags & PitSvFlags.WindshieldTearoff) !== 0;
  const currWindshield = (pitSvFlags & PitSvFlags.WindshieldTearoff) !== 0;

  if (prevWindshield !== currWindshield) {
    emit({ event: "pitService.toggled", data: { service: "windshield", on: currWindshield } });
  }

  const prevFastRepair = (state.lastPitSvFlags & PitSvFlags.FastRepair) !== 0;
  const currFastRepair = (pitSvFlags & PitSvFlags.FastRepair) !== 0;

  if (prevFastRepair !== currFastRepair) {
    emit({ event: "pitService.toggled", data: { service: "fastRepair", on: currFastRepair } });
  }

  // ── Tire service (4 tires, debounced) ──────────────────────────────────
  const baselineTireBits = state.lastPitSvFlags & TIRE_FLAGS_MASK;
  let nextBaselineTireBits = baselineTireBits;

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

  // ── Car control toggles ────────────────────────────────────────────────
  if (state.lastDrsActive !== drs) {
    emit({ event: "carControl.drsToggled", data: { on: drs } });
  }

  if (state.lastP2PActive !== p2p) {
    emit({ event: "carControl.p2pToggled", data: { on: p2p } });
  }

  if (state.lastLimiterActive !== limiter) {
    emit({ event: "carControl.limiterToggled", data: { on: limiter } });
  }

  // Non-tire bits track current. Tire bits track baseline (advanced only on emit).
  state.lastPitSvFlags = (pitSvFlags & ~TIRE_FLAGS_MASK) | nextBaselineTireBits;
  state.lastPitSvCompound = pitSvCompound;
  state.lastLimiterActive = limiter;
  state.lastP2PActive = p2p;
  state.lastDrsActive = drs;
}
