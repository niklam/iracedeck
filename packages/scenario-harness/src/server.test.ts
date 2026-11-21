import { createFakeAudio } from "@iracedeck/audio-service/testing";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import type { FastifyInstance } from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
import { failedRunTeardown, SCENARIO_SHORTCUTS } from "./scenario-shortcuts.js";
import {
  composeSectorComparison,
  getHarnessSectorComparison,
  setHarnessSectorComparison,
} from "./sector-comparison-snapshot.js";
import { createServer } from "./server.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("POST /api/bus/publish", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    initializeEventBus(silentLogger);
    app = await createServer({
      controller: new MockSDKController(),
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: createFakeAudio(),
      packageRoot: PACKAGE_ROOT,
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    _resetEventBus();
  });

  it("stamps every entry of one batch with one timestamp, as the translator stamps one tick's emits (issue #1211)", async () => {
    // The incident line's yield to the qualifying lap-invalidation line
    // matches `incident.scored` and `incident.occurred` by an EQUAL
    // timestamp. A clock that moves on every read stands in for a batch
    // straddling a millisecond boundary.
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock++);

    const seen: { event: string; timestamp: number }[] = [];
    const bus = getEventBus();
    bus.subscribe("incident.scored", (e) => seen.push({ event: e.event, timestamp: e.timestamp }));
    bus.subscribe("incident.occurred", (e) => seen.push({ event: e.event, timestamp: e.timestamp }));

    const res = await app.inject({
      method: "POST",
      url: "/api/bus/publish",
      payload: {
        events: [
          { event: "incident.scored", data: { delta: 4 } },
          { event: "incident.occurred", data: { delta: 4, points: 4, type: "collision-car" } },
        ],
      },
    });

    expect(res.statusCode).toBe(204);
    expect(seen.map((s) => s.event)).toEqual(["incident.scored", "incident.occurred"]);
    expect(seen[1].timestamp).toBe(seen[0].timestamp);
  });

  it("publishes nothing when any entry of the batch is invalid", async () => {
    const seen: string[] = [];
    getEventBus().subscribe("incident.scored", (e) => seen.push(e.event));

    const res = await app.inject({
      method: "POST",
      url: "/api/bus/publish",
      payload: {
        events: [
          { event: "incident.scored", data: { delta: 1 } },
          { event: "no.such.event", data: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("POST /api/telemetry", () => {
  let app: FastifyInstance;
  let controller: MockSDKController;
  let ticks: unknown[];

  beforeEach(async () => {
    initializeEventBus(silentLogger);
    // Connected and never started: no tick reaches a subscriber unless the
    // route makes one.
    controller = new MockSDKController({ onSubscriberError: "rethrow" });
    controller.setConnected(true);
    ticks = [];
    controller.subscribe("probe", (telemetry) => ticks.push(telemetry));
    ticks.length = 0;
    app = await createServer({
      controller,
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: createFakeAudio(),
      packageRoot: PACKAGE_ROOT,
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    await app.close();
    _resetEventBus();
  });

  it("ticks once, synchronously, after the patch when the body asks (#1349)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry",
      payload: { patch: { Speed: 40 }, tick: true },
    });

    expect(res.statusCode).toBe(200);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ Speed: 40 });
  });

  it("leaves the tick to the timer when the body does not ask", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry",
      payload: { patch: { Speed: 40 }, holdMs: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(ticks).toEqual([]);
    expect(controller.getState().telemetry).toMatchObject({ Speed: 40 });
  });

  // Issue #1548: a plain object is a bits patch or nothing.
  it("rejects a malformed bits patch with a 400 naming the key, writing nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry",
      payload: { patch: { Speed: 40, EngineWarnings: { mask: 16 } }, tick: true },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('"EngineWarnings"');
    expect(ticks).toEqual([]);
    expect(controller.getState().telemetry).toMatchObject({ Speed: 0, EngineWarnings: 0 });
  });

  it("applies a valid bits patch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry",
      payload: { patch: { EngineWarnings: { setBits: 16 } } },
    });

    expect(res.statusCode).toBe(200);
    expect(controller.getState().telemetry).toMatchObject({ EngineWarnings: 16 });
  });

  it("rejects a tick that is not a boolean, writing nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry",
      payload: { patch: { Speed: 40 }, tick: "yes" },
    });

    expect(res.statusCode).toBe(400);
    expect(ticks).toEqual([]);
    expect(controller.getState().telemetry).toMatchObject({ Speed: 0 });
  });
});

describe("POST /api/sector-comparison/snapshot", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    initializeEventBus(silentLogger);
    app = await createServer({
      controller: new MockSDKController(),
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: createFakeAudio(),
      packageRoot: PACKAGE_ROOT,
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    setHarnessSectorComparison(null);
    await app.close();
    _resetEventBus();
  });

  it("stores a composed comparison for the sector-comparison dependency and clears it on null (#1572)", async () => {
    const comparison = composeSectorComparison({ lap: 10, sectorCount: 3, player: { carIdx: 5, carNumber: "5" } });

    const stored = await app.inject({ method: "POST", url: "/api/sector-comparison/snapshot", payload: comparison });

    expect(stored.statusCode).toBe(204);
    expect(getHarnessSectorComparison()).toEqual(comparison);

    const cleared = await app.inject({
      method: "POST",
      url: "/api/sector-comparison/snapshot",
      headers: { "content-type": "application/json" },
      payload: "null",
    });

    expect(cleared.statusCode).toBe(204);
    expect(getHarnessSectorComparison()).toBeNull();
  });

  it("rejects a malformed comparison with a 400, keeping what was stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sector-comparison/snapshot",
      payload: { sectorCount: "3" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "sectorCount must be a non-negative integer" });
    expect(getHarnessSectorComparison()).toBeNull();
  });
});

describe("GET /api/state", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    initializeEventBus(silentLogger);
    app = await createServer({
      controller: new MockSDKController(),
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: createFakeAudio(),
      packageRoot: PACKAGE_ROOT,
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    await app.close();
    _resetEventBus();
  });

  it("serves each shortcut with a teardown with the copy the UI applies after a failed run (#1113)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/state" });
    const served = (res.json() as { shortcuts: Array<{ id: string; failedRunTeardownSequence?: unknown }> }).shortcuts;

    expect(res.statusCode).toBe(200);
    expect(served.map((s) => s.id)).toEqual(SCENARIO_SHORTCUTS.map((s) => s.id));

    for (const shortcut of SCENARIO_SHORTCUTS) {
      const failedRun = served.find((s) => s.id === shortcut.id)?.failedRunTeardownSequence;

      expect(failedRun, shortcut.id).toEqual(
        shortcut.teardownSequence === undefined ? undefined : failedRunTeardown(shortcut.teardownSequence),
      );
    }
  });
});
