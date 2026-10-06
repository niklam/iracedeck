import type { IAudioService } from "@iracedeck/audio-service";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import type { FastifyInstance } from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
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
      audio: { setPlaybackObserver: () => {} } as unknown as IAudioService,
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
    controller = new MockSDKController();
    controller.setConnected(true);
    ticks = [];
    controller.subscribe("probe", (telemetry) => ticks.push(telemetry));
    ticks.length = 0;
    app = await createServer({
      controller,
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: { setPlaybackObserver: () => {} } as unknown as IAudioService,
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
