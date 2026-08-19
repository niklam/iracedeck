import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEATURE_STARTUP_POLICY,
  FEATURE_STARTUP_GATES,
  FEATURE_STARTUP_POLICIES,
  resolveStartupGate,
} from "./feature-startup-policy.js";

describe("FEATURE_STARTUP_POLICIES", () => {
  it("lists the three policies and defaults to remember-last", () => {
    expect(FEATURE_STARTUP_POLICIES).toEqual(["remember-last", "always-on", "always-off"]);
    expect(DEFAULT_FEATURE_STARTUP_POLICY).toBe("remember-last");
  });
});

describe("resolveStartupGate", () => {
  it("carries the remembered value over under remember-last", () => {
    expect(resolveStartupGate("remember-last", true)).toBe(true);
    expect(resolveStartupGate("remember-last", false)).toBe(false);
  });

  it("forces the gate on under always-on regardless of the remembered value", () => {
    expect(resolveStartupGate("always-on", false)).toBe(true);
    expect(resolveStartupGate("always-on", true)).toBe(true);
  });

  it("forces the gate off under always-off regardless of the remembered value", () => {
    expect(resolveStartupGate("always-off", true)).toBe(false);
    expect(resolveStartupGate("always-off", false)).toBe(false);
  });
});

describe("FEATURE_STARTUP_GATES", () => {
  it("maps each feature's live gate, policy and retired key", () => {
    expect(FEATURE_STARTUP_GATES).toEqual([
      {
        gateKey: "pitCrewRaceEngineerEnabled",
        policyKey: "pitCrewRaceEngineerStartupPolicy",
        legacyKey: "pitCrewRaceEngineerEnabledOnStartup",
        label: "Race Engineer",
      },
      {
        gateKey: "pitCrewRadarEnabled",
        policyKey: "pitCrewRadarStartupPolicy",
        legacyKey: "pitCrewRadarEnabledOnStartup",
        label: "Radar",
      },
    ]);
  });
});
