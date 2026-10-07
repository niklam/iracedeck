import { homedir as osHomedir } from "node:os";
import { sep as pathSep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPTURE_PROFILE_RESULT_HOLD_MS,
  captureProfileStatusTitle,
  defaultSnapshotDir,
  generateTelemetryControlSvg,
  resolveSnapshotDir,
  TELEMETRY_CONTROL_GLOBAL_KEYS,
  TelemetryControl,
  TelemetryControlSettings,
} from "./telemetry-control.js";

const { mockTapBinding, mockMkdirSync, mockWriteFileSync, mockGetCurrentTelemetry, mockGetSessionInfo } = vi.hoisted(
  () => ({
    mockTapBinding: vi.fn().mockResolvedValue(undefined),
    mockMkdirSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockGetCurrentTelemetry: vi.fn(),
    mockGetSessionInfo: vi.fn(),
  }),
);

/** A stand-in for deck-core's shared CPU profile capture service (#1338). */
const captureFake = vi.hoisted(() => {
  type Status = { state: string; startedAt?: number; durationMs?: number; file?: string; reason?: string };
  const listeners = new Set<(status: Status) => void>();
  let current: Status = { state: "idle" };
  const fake = {
    initialized: true,
    listeners,
    publish(status: Status) {
      current = status;

      for (const listener of [...listeners]) listener(status);
    },
    reset() {
      listeners.clear();
      current = { state: "idle" };
      fake.initialized = true;
    },
    service: {
      // Like the real service: a request while one runs is refused, otherwise
      // "capturing" is published at once and the capture runs on.
      capture: vi.fn(async () => {
        if (current.state === "capturing") return { ok: false, reason: "a capture is already running", busy: true };

        fake.publish({ state: "capturing", startedAt: Date.now(), durationMs: 30_000 });

        return new Promise<never>(() => {});
      }),
      isCapturing: () => current.state === "capturing",
      status: () => current,
      onStatus: (listener: (status: Status) => void) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    },
  };

  return fake;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
  };
});

vi.mock("@iracedeck/icons/telemetry-control/toggle-logging.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/mark-event.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/start-recording.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/stop-recording.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/restart-recording.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/snapshot.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/capture-profile.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">capture-profile</svg>',
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({
    telem: {
      start: vi.fn(() => true),
      stop: vi.fn(() => true),
      restart: vi.fn(() => true),
    },
  })),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      // Return a mock Zod-like schema
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: mockGetCurrentTelemetry,
      getSessionInfo: mockGetSessionInfo,
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    setRegenerateCallback = vi.fn();
    isBindingMissing = vi.fn(() => false);
    setActiveBinding = vi.fn();
    tapBinding = mockTapBinding;
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  migrateLegacyActionToMode: (raw: unknown) => {
    if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

    const record = raw as Record<string, unknown>;

    if (record.mode !== undefined || record.action === undefined) {
      return { migrated: { ...record }, changed: false };
    }

    const { action, ...rest } = record;

    return { migrated: { ...rest, mode: action }, changed: true };
  },
  getCpuProfileCapture: vi.fn(() => {
    if (!captureFake.initialized) throw new Error("CPU profile capture not initialized");

    return captureFake.service;
  }),
  isCpuProfileCaptureInitialized: vi.fn(() => captureFake.initialized),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseBinding: vi.fn(),
  parseKeyBinding: vi.fn(),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
}));

const ALL_ACTIONS = [
  "toggle-logging",
  "mark-event",
  "start-recording",
  "stop-recording",
  "restart-recording",
  "snapshot",
  "capture-profile",
] as const;

describe("TelemetryControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("TELEMETRY_CONTROL_GLOBAL_KEYS", () => {
    it("should have exactly 2 keyboard-based actions", () => {
      expect(Object.keys(TELEMETRY_CONTROL_GLOBAL_KEYS)).toHaveLength(2);
    });

    it("should have correct mapping for toggle-logging", () => {
      expect(TELEMETRY_CONTROL_GLOBAL_KEYS["toggle-logging"]).toBe("telemetryControlToggleLogging");
    });

    it("should have correct mapping for mark-event", () => {
      expect(TELEMETRY_CONTROL_GLOBAL_KEYS["mark-event"]).toBe("telemetryControlMarkEvent");
    });

    it("should use telemetryControl prefix for all global keys", () => {
      for (const [_action, key] of Object.entries(TELEMETRY_CONTROL_GLOBAL_KEYS)) {
        expect(key).toMatch(/^telemetryControl/);
      }
    });

    it("should have unique global keys for all actions", () => {
      const values = Object.values(TELEMETRY_CONTROL_GLOBAL_KEYS);
      const uniqueValues = new Set(values);

      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe("generateTelemetryControlSvg", () => {
    it("should generate a valid data URI for toggle-logging", () => {
      const result = generateTelemetryControlSvg(TelemetryControlSettings.parse({ mode: "toggle-logging" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all actions", () => {
      for (const mode of ALL_ACTIONS) {
        const result = generateTelemetryControlSvg(TelemetryControlSettings.parse({ mode }));

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different actions", () => {
      const toggleLogging = generateTelemetryControlSvg(TelemetryControlSettings.parse({ mode: "toggle-logging" }));
      const markEvent = generateTelemetryControlSvg(TelemetryControlSettings.parse({ mode: "mark-event" }));

      expect(toggleLogging).not.toBe(markEvent);
    });

    it("should include correct labels for toggle-logging", () => {
      const result = generateTelemetryControlSvg(TelemetryControlSettings.parse({ mode: "toggle-logging" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LOGGING");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for mark-event", () => {
      const result = generateTelemetryControlSvg(TelemetryControlSettings.parse({ mode: "mark-event" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("MARK");
      expect(decoded).toContain("EVENT");
    });

    it("should include correct labels for all actions", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "toggle-logging": { mainLabel: "LOGGING", subLabel: "TOGGLE" },
        "mark-event": { mainLabel: "MARK", subLabel: "EVENT" },
        "start-recording": { mainLabel: "RECORDING", subLabel: "START" },
        "stop-recording": { mainLabel: "RECORDING", subLabel: "STOP" },
        "restart-recording": { mainLabel: "RECORDING", subLabel: "RESTART" },
        snapshot: { mainLabel: "TAKE", subLabel: "SNAPSHOT" },
        "capture-profile": { mainLabel: "CAPTURE", subLabel: "PROFILE" },
      };

      for (const [mode, labels] of Object.entries(expectedLabels)) {
        const result = generateTelemetryControlSvg(
          TelemetryControlSettings.parse({
            mode: mode as (typeof ALL_ACTIONS)[number],
          }),
        );
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });

  describe("snapshot mode", () => {
    const sampleTelemetry = {
      PlayerCarIdx: 1,
      Speed: 50,
      CarIdxPosition: [0, 1],
      CarIdxLapDistPct: [0, 0.5],
      CarIdxLap: [0, 3],
      CarIdxTrackSurface: [-1, 3],
    };
    const sampleSessionInfo = {
      WeekendInfo: { TrackDisplayName: "Test Track" },
      DriverInfo: { Drivers: [{ CarIdx: 1, CarNumber: "42", UserName: "Test Driver" }] },
    };

    function fakeEvent(actionId: string, settings: Record<string, unknown>) {
      return { action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings } };
    }

    // A platform-appropriate ABSOLUTE path (so resolveSnapshotDir returns it unchanged
    // on both Windows and POSIX CI runners).
    const absDir = process.platform === "win32" ? "C:\\snapshots" : "/tmp/snapshots";

    it("defaultSnapshotDir ends with the telemetry-snapshots folder under home", () => {
      expect(defaultSnapshotDir()).toMatch(/[\\/]iRaceDeck[\\/]telemetry-snapshots$/);
      // Must NOT assume a "Documents" known folder (OneDrive / localization safe).
      expect(defaultSnapshotDir()).not.toMatch(/Documents/i);
    });

    it("resolveSnapshotDir falls back to the default for blank input", () => {
      expect(resolveSnapshotDir("")).toBe(defaultSnapshotDir());
      expect(resolveSnapshotDir("   ")).toBe(defaultSnapshotDir());
      expect(resolveSnapshotDir(undefined)).toBe(defaultSnapshotDir());
    });

    it("resolveSnapshotDir keeps an absolute configured directory as-is", () => {
      const abs = process.platform === "win32" ? "C:\\snapshots" : "/tmp/snapshots";
      expect(resolveSnapshotDir(abs)).toBe(abs);
    });

    it("resolveSnapshotDir expands %VAR% environment placeholders", () => {
      process.env.IRD_TEST_SNAP = process.platform === "win32" ? "C:\\snap-env" : "/snap-env";

      try {
        expect(resolveSnapshotDir("%IRD_TEST_SNAP%")).toBe(process.env.IRD_TEST_SNAP);
      } finally {
        delete process.env.IRD_TEST_SNAP;
      }
    });

    it("resolveSnapshotDir resolves a relative path against home, not the process cwd", () => {
      const result = resolveSnapshotDir("snaps");
      // Resolved to an absolute path, and NOT under the current working directory
      // (which, in the running plugin, is the Stream Deck install folder).
      expect(result.endsWith(`${pathSep}snaps`)).toBe(true);
      expect(result).not.toBe("snaps");
      expect(result.startsWith(osHomedir())).toBe(true);
    });

    it("writes json and md files when telemetry is available", async () => {
      mockGetCurrentTelemetry.mockReturnValue(sampleTelemetry);
      mockGetSessionInfo.mockReturnValue(sampleSessionInfo);

      const action = new TelemetryControl();
      await action.onKeyDown(fakeEvent("a1", { mode: "snapshot", outputDir: absDir }) as never);

      expect(mockMkdirSync).toHaveBeenCalledWith(absDir, { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);

      const [jsonCall, mdCall] = mockWriteFileSync.mock.calls;
      expect(jsonCall[0]).toMatch(/telemetry-snapshot-\d{8}-\d{6}-\d{3}\.json$/);
      expect(mdCall[0]).toMatch(/telemetry-snapshot-\d{8}-\d{6}-\d{3}\.md$/);

      const jsonBody = JSON.parse(jsonCall[1] as string);
      expect(jsonBody.telemetry).toEqual(sampleTelemetry);
      expect(jsonBody.sessionInfo).toEqual(sampleSessionInfo);
      expect(mdCall[1]).toContain("Test Driver");
    });

    it("uses the default output directory when outputDir is blank", async () => {
      mockGetCurrentTelemetry.mockReturnValue(sampleTelemetry);
      mockGetSessionInfo.mockReturnValue(sampleSessionInfo);

      const action = new TelemetryControl();
      await action.onKeyDown(fakeEvent("a1", { mode: "snapshot" }) as never);

      expect(mockMkdirSync).toHaveBeenCalledWith(defaultSnapshotDir(), { recursive: true });
    });

    it("skips writing and warns when no telemetry is available", async () => {
      mockGetCurrentTelemetry.mockReturnValue(null);

      const action = new TelemetryControl();
      await action.onKeyDown(fakeEvent("a1", { mode: "snapshot" }) as never);

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect((action as never as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalled();
    });

    it("logs an error when the file write fails", async () => {
      mockGetCurrentTelemetry.mockReturnValue(sampleTelemetry);
      mockGetSessionInfo.mockReturnValue(sampleSessionInfo);
      // mockImplementationOnce (not mockImplementation): vi.clearAllMocks() in
      // beforeEach clears call history but NOT implementations, so a persistent
      // throw would leak into later tests. Scope it to this single call.
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      const action = new TelemetryControl();
      await action.onKeyDown(fakeEvent("a1", { mode: "snapshot", outputDir: absDir }) as never);

      const logger = (action as never as { logger: { error: ReturnType<typeof vi.fn> } }).logger;
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    });

    it("does not write files for non-snapshot modes", async () => {
      mockGetCurrentTelemetry.mockReturnValue(sampleTelemetry);

      const action = new TelemetryControl();
      await action.onKeyDown(fakeEvent("a1", { mode: "toggle-logging" }) as never);

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockTapBinding).toHaveBeenCalledWith("telemetryControlToggleLogging");
    });
  });

  describe("capture-profile mode (#1338)", () => {
    type ActionInternals = {
      logger: Record<"info" | "warn" | "debug", ReturnType<typeof vi.fn>>;
      updateKeyImage: ReturnType<typeof vi.fn>;
    };

    function fakeEvent(actionId: string, settings: Record<string, unknown> = { mode: "capture-profile" }) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn(), setSettings: vi.fn() },
        payload: { settings },
      };
    }

    const internals = (action: TelemetryControl) => action as never as ActionInternals;

    /** The title text of the last image pushed to `contextId`. */
    function lastTitle(action: TelemetryControl, contextId = "k1"): string {
      const calls = internals(action).updateKeyImage.mock.calls.filter(([id]) => id === contextId);
      const svg = decodeURIComponent(String(calls.at(-1)?.[1] ?? ""));

      return svg.replace(/^data:image\/svg\+xml,<svg><svg[^>]*>[^<]*<\/svg>/, "").replace(/<\/svg>$/, "");
    }

    beforeEach(() => {
      captureFake.reset();
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("titles the countdown in whole seconds, then the outcome", () => {
      expect(captureProfileStatusTitle({ kind: "capturing", endsAt: 31_000 }, 1000)).toBe("PROFILING\n30 s");
      expect(captureProfileStatusTitle({ kind: "capturing", endsAt: 31_000 }, 30_001)).toBe("PROFILING\n1 s");
      expect(captureProfileStatusTitle({ kind: "capturing", endsAt: 31_000 }, 40_000)).toBe("PROFILING\n0 s");
      expect(captureProfileStatusTitle({ kind: "saved" }, 0)).toBe("SAVED");
      expect(captureProfileStatusTitle({ kind: "failed" }, 0)).toBe("FAILED");
      expect(captureProfileStatusTitle({ kind: "idle" }, 0)).toBeUndefined();
    });

    it("starts the shared capture on a press, and sends nothing to iRacing", async () => {
      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);
      await action.onKeyDown(fakeEvent("k1") as never);

      expect(captureFake.service.capture).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("counts down once a second while the capture runs", async () => {
      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);
      await action.onKeyDown(fakeEvent("k1") as never);

      expect(lastTitle(action)).toBe("PROFILING\n30 s");

      vi.advanceTimersByTime(5000);

      expect(lastTitle(action)).toBe("PROFILING\n25 s");
    });

    it.each([
      ["saved", "SAVED", { state: "saved", startedAt: 1_000_000, file: "cpu-x.cpuprofile" }],
      ["failed", "FAILED", { state: "failed", startedAt: 1_000_000, reason: "disk full" }],
    ])("shows %s for 3 s, then its normal icon", async (_label, title, outcome) => {
      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);
      await action.onKeyDown(fakeEvent("k1") as never);
      vi.advanceTimersByTime(30_000);
      captureFake.publish(outcome);

      expect(lastTitle(action)).toBe(title);

      vi.advanceTimersByTime(CAPTURE_PROFILE_RESULT_HOLD_MS - 1);

      expect(lastTitle(action)).toBe(title);

      vi.advanceTimersByTime(1);

      expect(lastTitle(action)).toBe("CAPTURE\nPROFILE");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("shows a capture started from the Settings window, and a press during it is refused", async () => {
      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);

      // The window's button, through the same shared service.
      void captureFake.service.capture();

      expect(lastTitle(action)).toBe("PROFILING\n30 s");

      vi.advanceTimersByTime(10_000);
      await action.onKeyDown(fakeEvent("k1") as never);
      await vi.advanceTimersByTimeAsync(0);

      expect(captureFake.service.capture).toHaveBeenCalledTimes(2);
      expect(internals(action).logger.info).toHaveBeenCalledWith("CPU profile capture already running");
      // Still the window's capture: no restart of the countdown.
      expect(lastTitle(action)).toBe("PROFILING\n20 s");
    });

    it("picks up a capture already running when the key appears", async () => {
      captureFake.publish({ state: "capturing", startedAt: 1_000_000 - 12_000, durationMs: 30_000 });

      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);

      expect(lastTitle(action)).toBe("PROFILING\n18 s");
    });

    it("stops its timers and its status subscription when the last key disappears", async () => {
      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);
      await action.onWillAppear(fakeEvent("k2") as never);
      await action.onKeyDown(fakeEvent("k1") as never);

      expect(vi.getTimerCount()).toBe(1);

      await action.onWillDisappear(fakeEvent("k1") as never);

      expect(vi.getTimerCount()).toBe(1); // k2 still shows the countdown

      await action.onWillDisappear(fakeEvent("k2") as never);

      expect(vi.getTimerCount()).toBe(0);
      expect(captureFake.listeners.size).toBe(0);
    });

    it("stops following the capture when the key switches to another mode", async () => {
      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);
      await action.onKeyDown(fakeEvent("k1") as never);
      await action.onDidReceiveSettings(fakeEvent("k1", { mode: "snapshot" }) as never);

      expect(vi.getTimerCount()).toBe(0);
      expect(captureFake.listeners.size).toBe(0);
    });

    it("warns instead of throwing when the plugin has no capture service", async () => {
      captureFake.initialized = false;

      const action = new TelemetryControl();
      await action.onWillAppear(fakeEvent("k1") as never);
      await action.onKeyDown(fakeEvent("k1") as never);

      expect(captureFake.service.capture).not.toHaveBeenCalled();
      expect(internals(action).logger.warn).toHaveBeenCalledWith("CPU profile capture is not available in this plugin");
    });
  });
});
