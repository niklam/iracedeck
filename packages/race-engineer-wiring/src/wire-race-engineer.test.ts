import { registerPitCrew } from "@iracedeck/audio-scenarios/pit-crew";
import { silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIracingSimRuntime } from "./sim-runtime.js";
import { type RaceEngineerWiringDeps, wireRaceEngineer } from "./wire-race-engineer.js";

// Hoisted with the mock below, which reads it when registerPitCrew is called.
const order = vi.hoisted((): string[] => []);

vi.mock("@iracedeck/audio-scenarios/pit-crew", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPitCrew: vi.fn(() => order.push("registerPitCrew")),
}));

const bus = { subscribe: vi.fn((event: string) => order.push(`subscribe:${event}`)) };

// The settings package is real here: getGlobalSettings() answers the schema defaults, which
// is all these routing tests need. pit-crew-deps.test.ts swaps the settings.
function deps(extra: Partial<RaceEngineerWiringDeps> = {}): RaceEngineerWiringDeps {
  return { logger: silentLogger, sim: createIracingSimRuntime(), voice: { driverNames: [] }, ...extra };
}

describe("wireRaceEngineer", () => {
  beforeEach(() => {
    order.length = 0;
    vi.clearAllMocks();
  });

  it("subscribes every cache before registerPitCrew, whose where: clauses read them", () => {
    wireRaceEngineer(bus as never, deps());

    const register = order.indexOf("registerPitCrew");
    expect(register).toBeGreaterThan(0);
    expect(order.slice(0, register)).toEqual([
      "subscribe:lap.completed",
      "subscribe:cornerName.approaching",
      "subscribe:race.finished",
      "subscribe:overtake.completed",
      "subscribe:overtake.lost",
      "subscribe:incident.scored",
    ]);
  });

  it("passes the built dependencies, with an override winning", () => {
    const getQualifyingInvalidationSnapshot = vi.fn(() => null);

    const passed = wireRaceEngineer(bus as never, deps({ overrides: { getQualifyingInvalidationSnapshot } }));

    expect(vi.mocked(registerPitCrew)).toHaveBeenCalledExactlyOnceWith(bus, passed);
    expect(passed.getQualifyingInvalidationSnapshot).toBe(getQualifyingInvalidationSnapshot);
    expect(Object.keys(passed)).toHaveLength(28);
  });

  it("drops an override whose value is undefined rather than erasing the built dependency", () => {
    const built = wireRaceEngineer(bus as never, deps()).getSessionStartSnapshot;

    const passed = wireRaceEngineer(bus as never, deps({ overrides: { getSessionStartSnapshot: undefined } }));

    expect(typeof built).toBe("function");
    expect(typeof passed.getSessionStartSnapshot).toBe("function");
    expect(Object.values(passed).every((value) => value !== undefined)).toBe(true);
  });

  it("passes no override key when given none", () => {
    const passed = wireRaceEngineer(bus as never, deps());

    expect(Object.values(passed).every((value) => value !== undefined)).toBe(true);
  });
});
