import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generatePitQuickActionsSvg,
  isFastRepairAvailable,
  isFastRepairOn,
  isWindshieldOn,
  PitQuickActions,
  type PitQuickActionTelemetryState,
} from "./pit-quick-actions.js";

const {
  mockPitClear,
  mockPitWindshield,
  mockPitClearWindshield,
  mockPitFastRepair,
  mockPitClearFastRepair,
  mockGetCommands,
} = vi.hoisted(() => ({
  mockPitClear: vi.fn(() => true),
  mockPitWindshield: vi.fn(() => true),
  mockPitClearWindshield: vi.fn(() => true),
  mockPitFastRepair: vi.fn(() => true),
  mockPitClearFastRepair: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    pit: {
      clear: mockPitClear,
      windshield: mockPitWindshield,
      clearWindshield: mockPitClearWindshield,
      fastRepair: mockPitFastRepair,
      clearFastRepair: mockPitClearFastRepair,
    },
  })),
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  PitSvFlags: { WindshieldTearoff: 0x0020, FastRepair: 0x0040 },
  hasFlag: (value: number | undefined, flag: number) => value !== undefined && (value & flag) !== 0,
}));

vi.mock("@iracedeck/icons/pit-quick-actions/clear-all-checkboxes.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("../../icons/pit-quick-actions.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{titleContent}}{{iconContent}} {{backgroundColor}}</svg>',
}));

vi.mock("../icons/status-bar.js", () => ({
  statusBarOn: () => '<rect class="status-on"/>',
  statusBarOff: () => '<rect class="status-off"/>',
  statusBarNA: () => '<rect class="status-na"/>',
  borderColorForState: (state: string) => ({ on: "#2ecc71", off: "#e74c3c", na: "#888888" })[state],
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = { mode: "clear-all-checkboxes" };
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    updateKeyImage = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  getCommands: mockGetCommands,
  migrateLegacyActionToMode: (raw: unknown) => {
    if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

    const record = raw as Record<string, unknown>;

    if (record.mode !== undefined || record.action === undefined) {
      return { migrated: { ...record }, changed: false };
    }

    const { action, ...rest } = record;

    return { migrated: { ...rest, mode: action }, changed: true };
  },
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  getGlobalTitleSettings: vi.fn(() => ({})),
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
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({
    graphic1Color: "#ffffff",
  })),
  generateTitleText: vi.fn((opts: { text: string }) => `<text>${opts.text}</text>`),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value ?? "");
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("PitQuickActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("telemetry state helpers", () => {
    it("isWindshieldOn returns true when flag is set", () => {
      expect(isWindshieldOn({ PitSvFlags: 0x0020 } as any)).toBe(true);
    });

    it("isWindshieldOn returns false when flag is not set", () => {
      expect(isWindshieldOn({ PitSvFlags: 0 } as any)).toBe(false);
    });

    it("isWindshieldOn returns false when telemetry is null", () => {
      expect(isWindshieldOn(null)).toBe(false);
    });

    it("isFastRepairOn returns true when flag is set", () => {
      expect(isFastRepairOn({ PitSvFlags: 0x0040 } as any)).toBe(true);
    });

    it("isFastRepairOn returns false when flag is not set", () => {
      expect(isFastRepairOn({ PitSvFlags: 0 } as any)).toBe(false);
    });

    it("isFastRepairAvailable returns true when available > 0", () => {
      expect(isFastRepairAvailable({ FastRepairAvailable: 2 } as any)).toBe(true);
    });

    it("isFastRepairAvailable returns false when available is 0", () => {
      expect(isFastRepairAvailable({ FastRepairAvailable: 0 } as any)).toBe(false);
    });

    it("isFastRepairAvailable defaults to true when undefined", () => {
      expect(isFastRepairAvailable({} as any)).toBe(true);
    });

    it("isFastRepairAvailable defaults to true when telemetry is null", () => {
      expect(isFastRepairAvailable(null)).toBe(true);
    });
  });

  describe("generatePitQuickActionsSvg", () => {
    it("should generate a valid data URI for clear-all-checkboxes", () => {
      const result = generatePitQuickActionsSvg({ mode: "clear-all-checkboxes" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include correct labels for static action types", () => {
      const result = generatePitQuickActionsSvg({ mode: "clear-all-checkboxes" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("CLEAR ALL");
      expect(decoded).toContain("PIT");
    });

    it("should show ON status bar for windshield-tearoff when on", () => {
      const telemetryState: PitQuickActionTelemetryState = { windshieldOn: true };
      const result = generatePitQuickActionsSvg({ mode: "windshield-tearoff" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-on");
      expect(decoded).toContain("WINDSHIELD");
      expect(decoded).toContain("TEAROFF");
    });

    it("should show OFF status bar for windshield-tearoff when off", () => {
      const telemetryState: PitQuickActionTelemetryState = { windshieldOn: false };
      const result = generatePitQuickActionsSvg({ mode: "windshield-tearoff" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-off");
    });

    it("should show ON status bar for fast repair when on and available", () => {
      const telemetryState: PitQuickActionTelemetryState = { fastRepairOn: true, fastRepairAvailable: true };
      const result = generatePitQuickActionsSvg({ mode: "request-fast-repair" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-on");
      expect(decoded).toContain("FAST");
      expect(decoded).toContain("REPAIR");
    });

    it("should show N/A status bar for fast repair when not available", () => {
      const telemetryState: PitQuickActionTelemetryState = { fastRepairOn: false, fastRepairAvailable: false };
      const result = generatePitQuickActionsSvg({ mode: "request-fast-repair" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-na");
    });

    it("should use static icon for clear-all-checkboxes regardless of telemetry", () => {
      const telemetryState: PitQuickActionTelemetryState = { windshieldOn: true };
      const result = generatePitQuickActionsSvg({ mode: "clear-all-checkboxes" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).not.toContain("status-on");
      expect(decoded).not.toContain("status-off");
    });

    it("should show N/A status bar for windshield-tearoff when no telemetry is available", () => {
      const telemetryState: PitQuickActionTelemetryState = {};
      const result = generatePitQuickActionsSvg({ mode: "windshield-tearoff" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-na");
      expect(decoded).not.toContain("status-off");
    });

    it("should show N/A status bar for windshield-tearoff when telemetryState is undefined", () => {
      const result = generatePitQuickActionsSvg({ mode: "windshield-tearoff" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-na");
    });

    it("should show N/A status bar for fast repair when no telemetry is available", () => {
      const telemetryState: PitQuickActionTelemetryState = {};
      const result = generatePitQuickActionsSvg({ mode: "request-fast-repair" }, telemetryState);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-na");
      expect(decoded).not.toContain("status-off");
    });

    it("should show N/A status bar for fast repair when telemetryState is undefined", () => {
      const result = generatePitQuickActionsSvg({ mode: "request-fast-repair" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("status-na");
    });
  });

  describe("key press behavior", () => {
    let action: PitQuickActions;

    beforeEach(() => {
      action = new PitQuickActions();
    });

    it("should call pit.clear() on keyDown for clear-all-checkboxes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "clear-all-checkboxes" }) as any);

      expect(mockPitClear).toHaveBeenCalledOnce();
      expect(mockPitWindshield).not.toHaveBeenCalled();
      expect(mockPitFastRepair).not.toHaveBeenCalled();
    });

    it("should call pit.windshield() on keyDown when windshield is not set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
      await action.onKeyDown(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);

      expect(mockPitWindshield).toHaveBeenCalledOnce();
      expect(mockPitClearWindshield).not.toHaveBeenCalled();
    });

    it("should call pit.clearWindshield() on keyDown when windshield is already set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x0020 });
      await action.onKeyDown(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);

      expect(mockPitClearWindshield).toHaveBeenCalledOnce();
      expect(mockPitWindshield).not.toHaveBeenCalled();
    });

    it("should call pit.fastRepair() on keyDown when fast repair is not set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
      await action.onKeyDown(fakeEvent("action-1", { mode: "request-fast-repair" }) as any);

      expect(mockPitFastRepair).toHaveBeenCalledOnce();
      expect(mockPitClearFastRepair).not.toHaveBeenCalled();
    });

    it("should call pit.clearFastRepair() on keyDown when fast repair is already set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x0040 });
      await action.onKeyDown(fakeEvent("action-1", { mode: "request-fast-repair" }) as any);

      expect(mockPitClearFastRepair).toHaveBeenCalledOnce();
      expect(mockPitFastRepair).not.toHaveBeenCalled();
    });

    it("should not call any pit command when telemetry is null for windshield-tearoff", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue(null);
      await action.onKeyDown(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);

      expect(mockPitWindshield).not.toHaveBeenCalled();
      expect(mockPitClearWindshield).not.toHaveBeenCalled();
    });

    it("should not call any pit command when telemetry is null for request-fast-repair", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue(null);
      await action.onKeyDown(fakeEvent("action-1", { mode: "request-fast-repair" }) as any);

      expect(mockPitFastRepair).not.toHaveBeenCalled();
      expect(mockPitClearFastRepair).not.toHaveBeenCalled();
    });

    it("should default to clear-all-checkboxes when no action is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      expect(mockPitClear).toHaveBeenCalledOnce();
    });
  });

  describe("encoder behavior", () => {
    let action: PitQuickActions;

    beforeEach(() => {
      action = new PitQuickActions();
    });

    it("should call pit.clear() on dialDown for clear-all-checkboxes", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "clear-all-checkboxes" }) as any);

      expect(mockPitClear).toHaveBeenCalledOnce();
    });

    it("should call pit.windshield() on dialDown when windshield is not set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
      await action.onDialDown(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);

      expect(mockPitWindshield).toHaveBeenCalledOnce();
      expect(mockPitClearWindshield).not.toHaveBeenCalled();
    });

    it("should call pit.clearWindshield() on dialDown when windshield is already set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x0020 });
      await action.onDialDown(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);

      expect(mockPitClearWindshield).toHaveBeenCalledOnce();
      expect(mockPitWindshield).not.toHaveBeenCalled();
    });

    it("should call pit.fastRepair() on dialDown when fast repair is not set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
      await action.onDialDown(fakeEvent("action-1", { mode: "request-fast-repair" }) as any);

      expect(mockPitFastRepair).toHaveBeenCalledOnce();
      expect(mockPitClearFastRepair).not.toHaveBeenCalled();
    });

    it("should call pit.clearFastRepair() on dialDown when fast repair is already set", async () => {
      action.sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x0040 });
      await action.onDialDown(fakeEvent("action-1", { mode: "request-fast-repair" }) as any);

      expect(mockPitClearFastRepair).toHaveBeenCalledOnce();
      expect(mockPitFastRepair).not.toHaveBeenCalled();
    });
  });

  describe("telemetry subscription lifecycle", () => {
    let action: PitQuickActions;

    beforeEach(() => {
      action = new PitQuickActions();
    });

    it("should subscribe to telemetry on onWillAppear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);

      expect(action.sdkController.subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should unsubscribe from telemetry on onWillDisappear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "windshield-tearoff" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(action.sdkController.unsubscribe).toHaveBeenCalledWith("action-1");
    });
  });

  describe("legacy action -> mode migration", () => {
    it("should persist migrated settings on onWillAppear when legacy action is present", async () => {
      const action = new PitQuickActions();
      const setSettings = vi.fn().mockResolvedValue(undefined);
      const ev = {
        action: { id: "action-1", setTitle: vi.fn(), setImage: vi.fn(), setSettings },
        payload: { settings: { action: "windshield-tearoff" } },
      };
      await action.onWillAppear(ev as any);

      expect(setSettings).toHaveBeenCalledWith({ mode: "windshield-tearoff" });
    });
  });
});
