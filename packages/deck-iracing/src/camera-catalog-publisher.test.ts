import { CAMERA_CATALOG_KEY, type CameraCatalogView } from "@iracedeck/app-constants";
import type { SessionInfo } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { createMemorySettingsStore, type SettingsStore } from "@iracedeck/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCameraCatalogPublisher } from "./camera-catalog-publisher.js";
import { type CameraCatalogService, createCameraCatalogService } from "./camera-catalog-service.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");

/** A logger whose `error` is a spy and whose other levels are silent. */
function createMockLogger() {
  return { ...silentLogger, error: vi.fn<(message: string) => void>() } satisfies ILogger;
}

function session(trackId: unknown, groups: unknown[], trackName = "Spa"): SessionInfo {
  return {
    WeekendInfo: { TrackID: trackId, TrackDisplayName: trackName, TrackConfigName: "Grand Prix" },
    CameraInfo: { Groups: groups.map((name, i) => ({ GroupNum: i + 1, GroupName: name })) },
  } as unknown as SessionInfo;
}

interface Harness {
  service: CameraCatalogService;
  publishes: CameraCatalogView[];
  publish: ReturnType<typeof vi.fn<(partial: Record<string, unknown>) => void>>;
  logger: ReturnType<typeof createMockLogger>;
  setSessionInfo(info: SessionInfo | null): void;
  setCanPublish(value: boolean): void;
  tick(connected?: boolean): void;
  /** Starts the load; resolve it with `finishLoad`. */
  finishLoad(raw?: Record<string, unknown>): Promise<void>;
}

/**
 * A real catalog service over a memory store whose load the test releases,
 * wired the way `startServices` wires it: the publisher subscribed to the
 * service, its `onTick` standing in for the controller subscription.
 */
function harness(): Harness {
  let finish: (raw: Record<string, unknown> | undefined) => void = () => undefined;
  const memory: SettingsStore = {
    ...createMemorySettingsStore(),
    load: () => new Promise((resolve) => (finish = resolve)),
  };
  const service = createCameraCatalogService({
    path: "<memory>",
    logger: createMockLogger(),
    store: memory,
    now: () => NOW,
  });
  const publishes: CameraCatalogView[] = [];
  const publish = vi.fn<(partial: Record<string, unknown>) => void>((partial) => {
    publishes.push(JSON.parse(partial[CAMERA_CATALOG_KEY] as string) as CameraCatalogView);
  });
  let sessionInfo: SessionInfo | null = null;
  let canPublish = true;
  const logger = createMockLogger();
  const publisher = createCameraCatalogPublisher({
    catalog: service,
    getSessionInfo: () => sessionInfo,
    publish,
    canPublish: () => canPublish,
    logger,
  });

  service.subscribe(publisher.onCatalogChange);

  const loading = service.start();

  return {
    service,
    publishes,
    publish,
    logger,
    setSessionInfo: (info) => (sessionInfo = info),
    setCanPublish: (value) => (canPublish = value),
    tick: (connected = true) => publisher.onTick(null, connected),
    finishLoad: async (raw) => {
      finish(raw);
      await loading;
    },
  };
}

describe("createCameraCatalogPublisher (#1653)", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("publishes nothing before the catalog has loaded, then once it has, with the session seen meanwhile", async () => {
    h.setSessionInfo(session(13, ["Nose", "DynamicTV"]));
    h.tick();
    h.tick();
    expect(h.publish).not.toHaveBeenCalled();

    await h.finishLoad();

    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publishes[0]).toEqual({
      version: 1,
      tracks: [{ id: 13, name: "Spa", config: "Grand Prix" }],
      groups: [
        { name: "DynamicTV", tracks: [0], lastSeen: NOW.toISOString() },
        { name: "Nose", tracks: [0], lastSeen: NOW.toISOString() },
      ],
      current: { trackId: 13, groups: ["Nose", "DynamicTV"] },
    });
  });

  it("publishes the loaded catalog with no session when none is running", async () => {
    await h.finishLoad();

    expect(h.publishes).toEqual([{ version: 1, tracks: [], groups: [], current: null }]);
  });

  it("does not publish again on ticks with the same session info", async () => {
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();
    await h.finishLoad();
    h.tick();
    h.tick();

    expect(h.publish).toHaveBeenCalledOnce();
  });

  it("does not publish for a new session info whose track and groups are unchanged", async () => {
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();
    await h.finishLoad();
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();

    expect(h.publish).toHaveBeenCalledOnce();
  });

  it("publishes once when a camera file loaded mid-session changes the group list", async () => {
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();
    await h.finishLoad();
    h.setSessionInfo(session(13, ["Nose", "Grid_Pole", "Pit Lane2"]));
    h.tick();

    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publishes[1].current).toEqual({ trackId: 13, groups: ["Nose", "Grid_Pole", "Pit Lane 2"] });
    expect(h.publishes[1].groups.map((g) => g.name)).toEqual(["Grid_Pole", "Nose", "Pit Lane 2"]);
  });

  it("records a replay under its own track and publishes it as current", async () => {
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();
    await h.finishLoad();
    h.setSessionInfo(session(42, ["Blimp"], "Lakeland"));
    h.tick();

    const last = h.publishes.at(-1);

    expect(last?.tracks.map((t) => t.id)).toEqual([13, 42]);
    expect(last?.current).toEqual({ trackId: 42, groups: ["Blimp"] });
  });

  it("publishes current: null on disconnect, once, and reads the session afresh on reconnect", async () => {
    const info = session(13, ["Nose"]);

    h.setSessionInfo(info);
    h.tick();
    await h.finishLoad();
    h.tick(false);
    h.tick(false);

    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publishes[1].current).toBeNull();
    expect(h.publishes[1].tracks).toHaveLength(1);

    // The same object again after the reconnect is still a session to describe.
    h.tick();
    expect(h.publish).toHaveBeenCalledTimes(3);
    expect(h.publishes[2].current).toEqual({ trackId: 13, groups: ["Nose"] });
  });

  it("treats a session info without a track id or camera groups as no session, recording nothing", async () => {
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();
    await h.finishLoad();

    h.setSessionInfo(session(null, ["Drone"]));
    h.tick();
    expect(h.publishes.at(-1)?.current).toBeNull();

    h.setSessionInfo(session(9, []));
    h.tick();
    h.setSessionInfo(null);
    h.tick();

    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(Object.keys(h.service.getCatalog().tracks)).toEqual(["13"]);
    expect(Object.keys(h.service.getCatalog().groups)).toEqual(["Nose"]);
  });

  it("publishes a removal, and nothing for a removal that changed nothing", async () => {
    h.setSessionInfo(session(13, ["Nose", "Drone"]));
    h.tick();
    await h.finishLoad();

    expect(h.service.remove("Drone")).toBe(true);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publishes[1].groups.map((g) => g.name)).toEqual(["Nose"]);
    // Still on this track's list and in the session; only the remembered entry went.
    expect(h.publishes[1].current?.groups).toEqual(["Nose", "Drone"]);

    expect(h.service.remove("Drone")).toBe(false);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("waits for global settings, then publishes at the next trigger or tick", async () => {
    h.setCanPublish(false);
    h.setSessionInfo(session(13, ["Nose"]));
    h.tick();
    await h.finishLoad();
    expect(h.publish).not.toHaveBeenCalled();

    h.setCanPublish(true);
    h.tick();
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publishes[0].current).toEqual({ trackId: 13, groups: ["Nose"] });
  });

  it("keeps a publish whose write threw pending, and sends it at the next trigger", async () => {
    h.publish.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    h.setSessionInfo(session(13, ["Nose"]));
    await h.finishLoad();
    expect(h.publishes).toEqual([]);

    h.tick();
    expect(h.publishes).toHaveLength(1);
    expect(h.publishes[0].current).toEqual({ trackId: 13, groups: ["Nose"] });
  });

  it("never lets a throw escape a tick", async () => {
    await h.finishLoad();

    const throwing = createCameraCatalogPublisher({
      catalog: h.service,
      getSessionInfo: () => {
        throw new Error("boom");
      },
      publish: h.publish,
      canPublish: () => true,
      logger: h.logger,
    });

    expect(() => throwing.onTick(null, true)).not.toThrow();
    expect(h.logger.error).toHaveBeenCalledWith("The camera catalog could not follow the session");
  });

  it("publishes through the run-scoped key as JSON text", async () => {
    await h.finishLoad();

    const partial = h.publish.mock.calls[0][0];

    expect(Object.keys(partial)).toEqual([CAMERA_CATALOG_KEY]);
    expect(typeof partial[CAMERA_CATALOG_KEY]).toBe("string");
  });
});
