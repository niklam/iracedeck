import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import type { Core } from "../types.js";
import { initTrackStore } from "./track-store.js";

vi.mock("@iracedeck/track-store", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));

function fakeCore() {
  const logger = { name: "track store logger" };
  const createLogger = vi.fn(() => logger);
  const handlers = new Map<string, (ev: { data: unknown }) => void>();
  const bus = {
    subscribe: (name: string, handler: (ev: { data: unknown }) => void) => {
      callLog.push(`bus.subscribe ${name}`);
      handlers.set(name, handler);
    },
  };
  const core = { bus, adapter: { createLogger } } as unknown as Core;

  return { core, createLogger, logger, handlers };
}

describe("initTrackStore (#1112)", () => {
  let exitListenersBefore: Set<unknown>;
  let storeOptions: Record<string, unknown>[];
  let directoryOptions: unknown[];
  let recorded: unknown[];

  const store = {
    directory: "C:/data/Track Data",
    load: () => null,
    recordSample: (input: unknown) => {
      callLog.push("store.recordSample");
      recorded.push(input);

      return true;
    },
    flushSync: () => callLog.push("store.flushSync"),
  };

  beforeEach(() => {
    resetRecorder();
    storeOptions = [];
    directoryOptions = [];
    recorded = [];
    exitListenersBefore = new Set(process.listeners("exit"));
    implement("resolveTrackDataDirectory", (options) => {
      directoryOptions.push(options);

      return "C:/data/Track Data";
    });
    implement("initializeTrackStore", (options) => {
      storeOptions.push(options as Record<string, unknown>);

      return store;
    });
  });

  afterEach(() => {
    for (const listener of process.listeners("exit")) {
      if (!exitListenersBefore.has(listener)) process.removeListener("exit", listener);
    }
  });

  it("creates the store at the resolved folder, naming no sim, under a TrackStore logger, and subscribes once", () => {
    const { core, createLogger, logger } = fakeCore();

    const trackData = initTrackStore(core);

    expect(callLog).toEqual([
      "resolveTrackDataDirectory",
      "initializeTrackStore",
      "bus.subscribe pitLane.landmarkLearned",
    ]);
    // The process environment, so IRACEDECK_TRACK_DATA_DIR reaches the resolver; no platform, since the folder is shared.
    expect(directoryOptions).toEqual([{ env: process.env }]);
    expect((directoryOptions[0] as { env: unknown }).env).toBe(process.env);
    expect(createLogger).toHaveBeenCalledWith("TrackStore");
    expect(storeOptions).toHaveLength(1);
    // The sim comes with each sample's track identity, so the store is given none.
    expect(storeOptions[0]).toEqual({ directory: "C:/data/Track Data", logger });
    expect(trackData).toEqual({ store, directory: "C:/data/Track Data" });
    expect(trackData.store).toBe(store);
  });

  it("hands every learned landmark's payload to the store, whole", () => {
    const { core, handlers } = fakeCore();
    initTrackStore(core);
    callLog.length = 0;
    const data = {
      track: {
        sim: "iracing",
        trackId: 1,
        trackName: "a",
        trackConfigName: "b",
        trackLength: "1 km",
        trackLengthM: 1000,
        trackVersion: null,
      },
      landmark: "pitRoadStart",
      sample: { pct: 0.9, estTime: 80, carClassId: 1, key: "1:0:3:pitRoadStart:4", at: 1 },
      summary: { pct: 0.9, estTimeByClass: {}, samples: 1, published: false },
    };

    handlers.get("pitLane.landmarkLearned")?.({ data });
    handlers.get("pitLane.landmarkLearned")?.({ data });

    expect(callLog).toEqual(["store.recordSample", "store.recordSample"]);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toBe(data);
  });

  it("flushes the store synchronously on the way out, through one exit listener", () => {
    initTrackStore(fakeCore().core);

    const added = process.listeners("exit").filter((l) => !exitListenersBefore.has(l));
    expect(added).toHaveLength(1);
    callLog.length = 0;
    (added[0] as () => void)();
    expect(callLog).toEqual(["store.flushSync"]);
  });
});
