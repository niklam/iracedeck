import { homedir as osHomedir } from "node:os";
import { sep as pathSep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSnapshotDir,
  generateTelemetryControlSvg,
  resolveSnapshotDir,
  TELEMETRY_CONTROL_GLOBAL_KEYS,
  TelemetryControl,
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
  getCommands: vi.fn(() => ({
    telem: {
      start: vi.fn(() => true),
      stop: vi.fn(() => true),
      restart: vi.fn(() => true),
    },
  })),
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
      const result = generateTelemetryControlSvg({ mode: "toggle-logging" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all actions", () => {
      for (const mode of ALL_ACTIONS) {
        const result = generateTelemetryControlSvg({ mode });

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different actions", () => {
      const toggleLogging = generateTelemetryControlSvg({ mode: "toggle-logging" });
      const markEvent = generateTelemetryControlSvg({ mode: "mark-event" });

      expect(toggleLogging).not.toBe(markEvent);
    });

    it("should include correct labels for toggle-logging", () => {
      const result = generateTelemetryControlSvg({ mode: "toggle-logging" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LOGGING");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for mark-event", () => {
      const result = generateTelemetryControlSvg({ mode: "mark-event" });
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
      };

      for (const [mode, labels] of Object.entries(expectedLabels)) {
        const result = generateTelemetryControlSvg({
          mode: mode as (typeof ALL_ACTIONS)[number],
        });
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
});
