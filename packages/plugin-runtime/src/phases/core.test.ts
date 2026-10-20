import { LogLevel } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createFakeAdapter, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initCore } from "./core.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/diagnostics", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/deck-iracing", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
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

  it("registers the four plugin-state sections last, in the snapshot's key order (#1387)", () => {
    const names: unknown[] = [];
    implement("registerStateSection", (name) => names.push(name));

    initCore(createHost());

    expect(names).toEqual(["environment", "settings", "sim", "raceEngineer"]);
    expect(callLog.slice(-4)).toEqual([
      "registerStateSection",
      "registerStateSection",
      "registerStateSection",
      "registerStateSection",
    ]);
    // Registering reads nothing: every one of these is a call a reader makes at the press.
    expect(callLog).not.toContain("getPluginVersion");
    expect(callLog).not.toContain("isSettingsStoreReady");
    expect(callLog).not.toContain("readSettingsForSnapshot");
    expect(callLog).not.toContain("readSimState");
  });

  it("hands the environment section the controller it returns, read at the press (#1387)", () => {
    const readers = new Map<unknown, () => unknown>();
    implement("registerStateSection", (name, section) => readers.set(name, (section as { read: () => unknown }).read));

    initCore(createHost());
    callLog.length = 0;
    readers.get("environment")?.();

    // `getController().…`: the handle `initCore` took, not a second `getController` call.
    expect(callLog).toEqual([
      "getPluginVersion",
      "getPluginPlatform",
      "getController().getConnectionStatus",
      "isIRacingActive",
      "hasElevationMismatch",
      "isSettingsStoreReady",
      "getSettingsStoreSource",
    ]);
  });

  describe("the native addons' load report (#1373)", () => {
    /** Each package's `getNativeLoadStatus` is recorded under the same name; initCore reads iRacing's first. */
    function implementLoadStatuses(...statuses: unknown[]): void {
      const queue = [...statuses];
      implement("getNativeLoadStatus", () => queue.shift());
    }

    /** A host whose logger records every error line under its scope. */
    function hostRecordingErrors(): { host: ReturnType<typeof createHost>; errors: [string, string][] } {
      const host = createHost();
      const errors: [string, string][] = [];
      const createLogger = host.adapter.createLogger;
      host.adapter.createLogger = (scope: string) => ({
        ...createLogger(scope),
        error: (message: string) => errors.push([scope, message]),
      });

      return { host, errors };
    }

    it("logs one error per failed addon, naming it and carrying its error, under NativeAddons", () => {
      implementLoadStatuses(
        { kind: "load-failed", error: "iracing_native.node is not a valid Win32 application." },
        { kind: "load-failed", error: "audio_native.node: The specified module could not be found." },
      );
      const { host, errors } = hostRecordingErrors();

      initCore(host);

      expect(errors).toHaveLength(2);
      expect(errors[0][0]).toBe("NativeAddons");
      expect(errors[0][1]).toMatch(/^iRacing native addon /);
      expect(errors[0][1].endsWith(": iracing_native.node is not a valid Win32 application.")).toBe(true);
      expect(errors[1][0]).toBe("NativeAddons");
      expect(errors[1][1]).toMatch(/^Audio native addon /);
      expect(errors[1][1].endsWith(": audio_native.node: The specified module could not be found.")).toBe(true);
    });

    it("logs only the addon that failed", () => {
      implementLoadStatuses({ kind: "native" }, { kind: "load-failed", error: "quarantined" });
      const { host, errors } = hostRecordingErrors();

      initCore(host);

      expect(errors.map(([, message]) => message)).toEqual([
        expect.stringMatching(/^Audio native addon .*: quarantined$/),
      ]);
    });

    it("logs nothing, and makes no logger, for a native or mock load", () => {
      implementLoadStatuses({ kind: "native" }, { kind: "mock", reason: "forced" });
      const { host, errors } = hostRecordingErrors();

      initCore(host);

      expect(errors).toEqual([]);
      expect(host.adapter.scopes).not.toContain("NativeAddons");
    });

    it("hands the statuses on in Core, for the banners and the snapshot", () => {
      const iracing = { kind: "load-failed", error: "x" };
      const audio = { kind: "mock", reason: "platform" };
      implementLoadStatuses(iracing, audio);

      expect(initCore(createHost()).nativeAddons).toEqual({ iracing, audio });
    });
  });

  it("returns the bus initializeEventBus made", () => {
    const bus = { subscribe: () => undefined };
    implement("initializeEventBus", () => bus);

    expect(initCore(createHost()).bus).toBe(bus);
  });
});
