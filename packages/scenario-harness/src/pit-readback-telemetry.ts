/**
 * Translate a `PitReadbackSnapshot` (the harness UI's composer state) into a
 * `Partial<TelemetryData>` that the mock SDK controller can apply.
 *
 * Mirrors `buildSnapshot()` in `@iracedeck/sim-events-iracing/diff/pit-readback`
 * field-for-field so the round-trip
 * `snapshot → snapshotToTelemetryPatch → mutateTelemetry → buildSnapshot`
 * is the identity for any snapshot the production code can emit.
 *
 * Why not embed the snapshot in the readback event payload instead? The
 * production audio scenarios deliberately ignore the event payload and
 * pull a fresh snapshot from the translator at fire time (issue #481), so
 * deferred replays speak the *current* telemetry. The harness has to drive
 * telemetry too if its UI selections are to reach the readback at all.
 *
 * Limitation: `PitReadbackSnapshot.windshield.available` has no telemetry
 * source — `buildSnapshot()` hardcodes it to `true`. The UI's "Available"
 * checkbox under Windshield is therefore non-functional from the snapshot's
 * point of view; this translator silently drops it.
 */
import type { PitReadbackSnapshot } from "@iracedeck/event-bus";
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * Build a telemetry patch from the UI snapshot. `current` provides the bits
 * we don't own (other `EngineWarnings` flags) so they survive the patch.
 */
export function snapshotToTelemetryPatch(
  snapshot: PitReadbackSnapshot,
  current: TelemetryData,
): Partial<TelemetryData> {
  let flags = 0;

  if (snapshot.fuel.queued) flags |= PitSvFlags.FuelFill;

  if (snapshot.tires.lf) flags |= PitSvFlags.LFTireChange;

  if (snapshot.tires.rf) flags |= PitSvFlags.RFTireChange;

  if (snapshot.tires.lr) flags |= PitSvFlags.LRTireChange;

  if (snapshot.tires.rr) flags |= PitSvFlags.RRTireChange;

  if (snapshot.fastRepair.queued) flags |= PitSvFlags.FastRepair;

  if (snapshot.windshield.queued) flags |= PitSvFlags.WindshieldTearoff;

  // When `compoundChange` is null the snapshot type carries no info about
  // which compound is on the car, so preserve whatever was last set —
  // anything else would clobber a value the user established earlier in
  // the same composer session. Both fields are written equal so
  // `buildSnapshot()`'s `compound !== playerCompound` check returns false,
  // matching the null compoundChange we started from.
  const playerCompound = snapshot.compoundChange?.from ?? current.PlayerTireCompound ?? 0;
  const queuedCompound = snapshot.compoundChange?.to ?? playerCompound;

  // Other diff modules read `EngineWarnings`, so we OR/AND only the
  // PitSpeedLimiter bit and leave the rest alone.
  const currentWarnings = current.EngineWarnings ?? 0;
  const cleared = currentWarnings & ~EngineWarnings.PitSpeedLimiter;
  const engineWarnings = snapshot.limiterEngaged ? cleared | EngineWarnings.PitSpeedLimiter : cleared;

  return {
    PitSvFlags: flags,
    PitSvTireCompound: queuedCompound,
    PlayerTireCompound: playerCompound,
    EngineWarnings: engineWarnings,
    FastRepairAvailable: snapshot.fastRepair.available ? 1 : 0,
  };
}
