import type { PitReadbackSnapshot } from "@iracedeck/event-bus";
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { snapshotToTelemetryPatch } from "./pit-readback-telemetry.js";

const EMPTY_SNAPSHOT: PitReadbackSnapshot = {
  fuel: { queued: false },
  tires: { lf: false, rf: false, lr: false, rr: false },
  compoundChange: null,
  fastRepair: { queued: false, available: false },
  windshield: { queued: false, available: false },
  limiterEngaged: false,
  hasPitLimiter: false,
  hasDamage: false,
};

const ZERO_TELEMETRY = {
  PitSvFlags: 0,
  PitSvTireCompound: 0,
  PlayerTireCompound: 0,
  EngineWarnings: 0,
  FastRepairAvailable: 0,
} as unknown as TelemetryData;

describe("snapshotToTelemetryPatch", () => {
  it("clears every owned field for an empty snapshot", () => {
    expect(snapshotToTelemetryPatch(EMPTY_SNAPSHOT, ZERO_TELEMETRY)).toEqual({
      PitSvFlags: 0,
      PitSvTireCompound: 0,
      PlayerTireCompound: 0,
      EngineWarnings: 0,
      FastRepairAvailable: 0,
    });
  });

  it("ORs every PitSvFlags bit when every service is queued", () => {
    const snapshot: PitReadbackSnapshot = {
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: true, rr: true },
      compoundChange: null,
      fastRepair: { queued: true, available: true },
      windshield: { queued: true, available: true },
      limiterEngaged: true,
      hasPitLimiter: true,
      hasDamage: false,
    };

    const patch = snapshotToTelemetryPatch(snapshot, ZERO_TELEMETRY);

    expect(patch.PitSvFlags).toBe(
      PitSvFlags.FuelFill |
        PitSvFlags.LFTireChange |
        PitSvFlags.RFTireChange |
        PitSvFlags.LRTireChange |
        PitSvFlags.RRTireChange |
        PitSvFlags.FastRepair |
        PitSvFlags.WindshieldTearoff,
    );
    expect(patch.FastRepairAvailable).toBe(1);
    expect(patch.EngineWarnings).toBe(EngineWarnings.PitSpeedLimiter);
  });

  it("sets only the requested tire bits", () => {
    const snapshot: PitReadbackSnapshot = {
      ...EMPTY_SNAPSHOT,
      tires: { lf: true, rf: true, lr: false, rr: false }, // fronts
    };

    expect(snapshotToTelemetryPatch(snapshot, ZERO_TELEMETRY).PitSvFlags).toBe(
      PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
    );
  });

  it("writes both compound fields for a queued change", () => {
    const snapshot: PitReadbackSnapshot = {
      ...EMPTY_SNAPSHOT,
      tires: { lf: true, rf: true, lr: true, rr: true },
      compoundChange: { from: 0, to: 1 },
    };

    const patch = snapshotToTelemetryPatch(snapshot, ZERO_TELEMETRY);

    expect(patch.PlayerTireCompound).toBe(0);
    expect(patch.PitSvTireCompound).toBe(1);
  });

  it("keeps PitSvTireCompound equal to PlayerTireCompound when compoundChange is null", () => {
    const current = { ...ZERO_TELEMETRY, PlayerTireCompound: 1 } as unknown as TelemetryData;

    const patch = snapshotToTelemetryPatch(EMPTY_SNAPSHOT, current);

    expect(patch.PlayerTireCompound).toBe(1);
    expect(patch.PitSvTireCompound).toBe(1);
  });

  it("preserves unrelated EngineWarnings bits when toggling the limiter", () => {
    const otherBit = EngineWarnings.WaterTempWarning;
    const current = {
      ...ZERO_TELEMETRY,
      EngineWarnings: otherBit | EngineWarnings.PitSpeedLimiter,
    } as unknown as TelemetryData;

    // Limiter off in the snapshot — limiter bit clears, the other bit survives.
    const off = snapshotToTelemetryPatch(EMPTY_SNAPSHOT, current);
    expect(off.EngineWarnings).toBe(otherBit);

    // Limiter on — limiter bit set, the other bit survives.
    const on = snapshotToTelemetryPatch({ ...EMPTY_SNAPSHOT, limiterEngaged: true }, current);
    expect(on.EngineWarnings).toBe(otherBit | EngineWarnings.PitSpeedLimiter);
  });

  // Issue #489: damage bits in the harness are owned by the dedicated
  // EngineWarnings panel, not the readback composer. The composer's
  // snapshot push must therefore preserve any damage bits the user has
  // set independently — even though the snapshot type carries a
  // `hasDamage` field, that field is informational here.
  it("preserves the damage bits regardless of the snapshot's hasDamage value", () => {
    const current = {
      ...ZERO_TELEMETRY,
      EngineWarnings: EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded,
    } as unknown as TelemetryData;

    const withFalse = snapshotToTelemetryPatch({ ...EMPTY_SNAPSHOT, hasDamage: false }, current);
    expect(withFalse.EngineWarnings).toBe(EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded);

    const withTrue = snapshotToTelemetryPatch({ ...EMPTY_SNAPSHOT, hasDamage: true }, current);
    expect(withTrue.EngineWarnings).toBe(EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded);
  });

  it("encodes fast-repair availability independent of queued state", () => {
    const queuedAvailable = snapshotToTelemetryPatch(
      { ...EMPTY_SNAPSHOT, fastRepair: { queued: true, available: true } },
      ZERO_TELEMETRY,
    );
    expect(queuedAvailable.FastRepairAvailable).toBe(1);
    expect(queuedAvailable.PitSvFlags! & PitSvFlags.FastRepair).not.toBe(0);

    const queuedUnavailable = snapshotToTelemetryPatch(
      { ...EMPTY_SNAPSHOT, fastRepair: { queued: true, available: false } },
      ZERO_TELEMETRY,
    );
    expect(queuedUnavailable.FastRepairAvailable).toBe(0);
    expect(queuedUnavailable.PitSvFlags! & PitSvFlags.FastRepair).not.toBe(0);
  });
});
