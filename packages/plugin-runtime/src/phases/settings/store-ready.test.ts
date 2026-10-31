import { VERSION_CHECK_STARTUP_GRACE_MS } from "@iracedeck/app-updates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import { createStoreReadyStep } from "./store-ready.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/diagnostics", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings-window", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/app-updates", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/deck-iracing", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("../../actions.js", async () => (await import("../../test-support/module-mocks.js")).actionsMock());

const STORE_PATH = "C:/plugin/settings.json";

/** The step over recorded stand-ins: each collaborator's calls land in `callLog` under its own name. */
function build() {
  return createStoreReadyStep({
    audio: stub("audio"),
    voicePacks: stub("voicePacks"),
    store: { path: STORE_PATH },
    settingsWindow: stub("settingsWindow"),
    notices: stub("notices"),
  });
}

describe("createStoreReadyStep (#1377)", () => {
  let started: { resolve: (channel: unknown) => void; reject: (error: unknown) => void };

  beforeEach(() => {
    resetRecorder();
    vi.useFakeTimers();
    implement("getGlobalSettings", () => ({}));
    implement(
      "settingsWindow.controller.ensureStarted",
      () =>
        new Promise((resolve, reject) => {
          started = { resolve, reject };
        }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing while the settings store is not ready, and runs on the first ready arrival", () => {
    let ready = false;
    implement("isSettingsStoreReady", () => ready);
    const step = build();

    step.runIfReady();
    expect(callLog).toEqual(["isSettingsStoreReady"]);

    ready = true;
    step.runIfReady();
    expect(callLog).toContain("audio.armFeatureGateSync");
  });

  it("runs its calls in today's order", () => {
    implement("isSettingsStoreReady", () => true);

    build().runIfReady();

    expect(callLog).toEqual([
      "isSettingsStoreReady",
      "notices.arm", // with the one-shot flag, as the shared flag was set
      "deleteGlobalSettings", // #515
      "deleteGlobalSettings", // #657
      "migrateLfeIntensityBindingKeys",
      "migrateStartupPolicies",
      "applyStartupFeatureGates",
      "audio.armFeatureGateSync",
      "updateGlobalSettings", // _settingsStorePath
      "settingsWindow.controller.ensureStarted",
      "getGlobalSettings", // the catalog-override warning
    ]);
  });

  it("runs once, and never asks the store again after it has run", () => {
    implement("isSettingsStoreReady", () => true);
    const step = build();

    step.runIfReady();
    callLog.length = 0;
    step.runIfReady();

    expect(callLog).toEqual([]);
  });

  it("deletes the retired keys and publishes the store path", () => {
    implement("isSettingsStoreReady", () => true);
    const deleted: unknown[] = [];
    const written: unknown[] = [];
    implement("deleteGlobalSettings", (keys) => deleted.push(keys));
    implement("updateGlobalSettings", (partial) => written.push(partial));

    build().runIfReady();

    expect(deleted).toEqual([
      ["raceEngineerEnabled", "radarEnabled", "raceEngineerEnabledOnStartup", "radarEnabledOnStartup"],
      ["calloutEnabledFlagOneLapToGreen"],
    ]);
    expect(written).toEqual([{ _settingsStorePath: STORE_PATH }]);
  });

  it("arms the notices with the window's opener and runs them after the startup grace (#870)", async () => {
    implement("isSettingsStoreReady", () => true);
    const openers: (() => unknown)[] = [];
    implement("notices.arm", (open) => openers.push(open as () => unknown));

    build().runIfReady();

    expect(openers).toHaveLength(1);
    callLog.length = 0;
    openers[0]();
    expect(callLog).toEqual(["settingsWindow.openSettingsWindow"]);

    callLog.length = 0;
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_STARTUP_GRACE_MS - 1);
    expect(callLog).not.toContain("notices.run");
    await vi.advanceTimersByTimeAsync(1);
    expect(callLog).toEqual(["notices.run"]);
  });

  it("publishes the channel once the settings server has started", async () => {
    implement("isSettingsStoreReady", () => true);
    const published: unknown[] = [];
    implement("settingsWindow.channel.publish", (channel) => published.push(channel));

    build().runIfReady();
    callLog.length = 0;
    started.resolve({ port: 1, token: "t" });
    await vi.advanceTimersByTimeAsync(0);

    expect(callLog).toEqual(["settingsWindow.channel.publish"]);
    expect(published).toEqual([{ port: 1, token: "t" }]);
  });

  it("mirrors the store without a channel when the server fails to start (#1005)", async () => {
    implement("isSettingsStoreReady", () => true);

    build().runIfReady();
    callLog.length = 0;
    started.reject(new Error("EADDRINUSE"));
    await vi.advanceTimersByTimeAsync(0);

    expect(callLog).toEqual(["settingsWindow.channel.publishUnavailable"]);
  });
});
