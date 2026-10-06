import { silentLogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeRaceEngineerCaches } from "./caches.js";

type Handler = (ev: { data: unknown }) => void;

function fakeBus() {
  const handlers = new Map<string, Handler>();
  const bus = { subscribe: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)) };

  return { bus, emit: (event: string, data: unknown) => handlers.get(event)?.({ data }) };
}

describe("subscribeRaceEngineerCaches", () => {
  // Undoes the Date.now spy, even when a test fails before reaching its end.
  afterEach(() => vi.restoreAllMocks());

  it("makes its loggers as scopes of the one it is given", () => {
    const scopes: string[] = [];
    const root = { ...silentLogger, createScope: (scope: string) => (scopes.push(scope), silentLogger) };

    subscribeRaceEngineerCaches(fakeBus().bus as never, root);

    expect(scopes).toEqual(["LapCompleted", "RaceFinished", "Overtake"]);
  });

  it("subscribes the six events in today's order", () => {
    const { bus } = fakeBus();

    subscribeRaceEngineerCaches(bus as never, silentLogger);

    expect(bus.subscribe.mock.calls.map(([event]) => event)).toEqual([
      "lap.completed",
      "cornerName.approaching",
      "race.finished",
      "overtake.completed",
      "overtake.lost",
      "incident.scored",
    ]);
  });

  it("holds the last payload of each cached event, and null before the first", () => {
    const { bus, emit } = fakeBus();
    const caches = subscribeRaceEngineerCaches(bus as never, silentLogger);

    expect(caches.lapCompleted()).toBeNull();
    expect(caches.cornerName()).toBeNull();
    expect(caches.raceFinished()).toBeNull();
    expect(caches.lastIncidentAt()).toBeNull();

    const lap = { lap: 3, lapTime: 92.5, isBest: true, isFirstValid: false };
    emit("lap.completed", lap);
    emit("cornerName.approaching", { name: "Eau Rouge" });
    emit("race.finished", { position: 4 });
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    emit("incident.scored", {});

    expect(caches.lapCompleted()).toBe(lap);
    expect(caches.cornerName()).toEqual({ name: "Eau Rouge" });
    expect(caches.raceFinished()).toEqual({ position: 4 });
    expect(caches.lastIncidentAt()).toBe(1_000);
  });
});
