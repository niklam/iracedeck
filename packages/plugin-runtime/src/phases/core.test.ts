import { LogLevel } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createFakeAdapter, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initCore } from "./core.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/event-bus", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/sim-events-iracing", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-service", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/audio-scenarios", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/rasterizer", async () => (await import("../test-support/module-mocks.js")).rasterizerMock());
vi.mock("@iracedeck/race-engineer-wiring", async () =>
  (await import("../test-support/module-mocks.js")).raceEngineerWiringMock(),
);
vi.mock("../actions.js", async () => (await import("../test-support/module-mocks.js")).actionsMock());

describe("initCore", () => {
  beforeEach(() => resetRecorder());
  afterAll(() => cleanupTempBinDirs());

  it("runs config → log level → watchdog → resource monitor → setup-warning check → SDK → bus, in that order", () => {
    initCore(createHost());

    expect(
      callLog.filter((name) =>
        [
          "initPluginConfig",
          "onGlobalSettingsChange",
          "adapter.setLogLevel",
          "startMainThreadWatchdog",
          "startResourceMonitor",
          "validateSetupWarningPatterns",
          "initializeSDK",
          "initializeEventBus",
        ].includes(name),
      ),
    ).toEqual([
      "initPluginConfig",
      "onGlobalSettingsChange",
      "adapter.setLogLevel",
      "startMainThreadWatchdog",
      "startResourceMonitor",
      "onGlobalSettingsChange",
      "validateSetupWarningPatterns",
      "initializeSDK",
      "initializeEventBus",
    ]);
  });

  it("creates its loggers under the scopes the host logs always used", () => {
    const host = createHost();

    initCore(host);

    expect(host.adapter.scopes).toEqual(["MainThreadWatchdog", "ResourceMonitor", "iRacingSDK", "EventBus"]);
  });

  it("refuses an adapter that writes no log file, before the watchdog starts (#1330)", () => {
    const host = { ...createHost(), adapter: { ...createFakeAdapter(), logLocation: undefined } };

    expect(() => initCore(host)).toThrow(/log directory/);
    // Positive control: the phase ran up to the check, so the watchdog's absence is the refusal.
    expect(callLog).toContain("adapter.setLogLevel");
    expect(callLog).not.toContain("startMainThreadWatchdog");
  });

  it("hands initPluginConfig the bin dir's config.json", () => {
    const configs: unknown[] = [];
    implement("initPluginConfig", (config) => configs.push(config));
    const host = createHost();

    initCore(host);

    expect(configs).toEqual([JSON.parse(readFileSync(join(host.binDir, "config.json"), "utf-8"))]);
  });

  it("maps debugLogging to the adapter's level, live (#609)", () => {
    const listeners: ((settings: { debugLogging: boolean }) => void)[] = [];
    implement("onGlobalSettingsChange", (listener) => listeners.push(listener as never));
    implement("getGlobalSettings", () => ({ debugLogging: false }));
    const host = createHost();
    const levels: LogLevel[] = [];
    host.adapter.setLogLevel = (level) => levels.push(level);

    initCore(host);
    listeners[0]({ debugLogging: true });
    listeners[0]({ debugLogging: false });

    expect(levels).toEqual([LogLevel.Info, LogLevel.Debug, LogLevel.Info]);
  });

  it("points the watchdog at the adapter's log location (#1330)", () => {
    const targets: unknown[] = [];
    implement("startMainThreadWatchdog", (options) => targets.push((options as { target: unknown }).target));

    initCore(createHost(undefined, { kind: "file", path: "C:/sd/logs/x.0.log" }));

    expect(targets).toEqual([{ kind: "file", path: "C:/sd/logs/x.0.log" }]);
  });

  it("returns the bus initializeEventBus made", () => {
    const bus = { subscribe: () => undefined };
    implement("initializeEventBus", () => bus);

    expect(initCore(createHost()).bus).toBe(bus);
  });
});
