import { getCommands, requestProfileSwitch, resolveProfileNameForDevice } from "@iracedeck/deck-core";
import { getAllCarNumbers, getCamerasInGroup, getCarNumberRawFromSessionInfo } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSelectIntents, getSelectIntent } from "../../shared/car-select-intent.js";
import {
  CAMERA_GROUP_MAP,
  CAMERA_GROUPS_SETTING_KEY,
  CameraControls,
  computeGridPositions,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  extractIconArtwork,
  generateCameraControlsSvg,
  generateCycleCameraGridSvg,
  getEnabledGroupNames,
  getNextSelectedGroup,
  parseGroupSubset,
} from "./camera-controls.js";

// Cycle icon mocks
vi.mock("@iracedeck/icons/camera-cycle/camera-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">camera-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/camera-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">camera-previous {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/sub-camera-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">sub-camera-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/sub-camera-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">sub-camera-previous {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/car-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">car-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/car-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">car-previous {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/driving-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">driving-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/driving-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">driving-previous {{mainLabel}} {{subLabel}}</svg>',
}));

// Camera select icon mocks — structured SVGs for artwork extraction
function mockCameraSelectSvg(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><desc>{"colors":{"backgroundColor":"#2a4a5a","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc><g filter="url(#activity-state)"><rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/><g class="${name}-artwork"><path d="M0 0" fill="{{graphic1Color}}"/></g><text x="72" y="116" text-anchor="middle" fill="{{textColor}}">{{subLabel}}</text><text x="72" y="138" text-anchor="middle" fill="{{textColor}}">{{mainLabel}}</text></g></svg>`;
}

vi.mock("@iracedeck/icons/camera-select/blimp.svg", () => ({ default: mockCameraSelectSvg("blimp") }));
vi.mock("@iracedeck/icons/camera-select/chase.svg", () => ({ default: mockCameraSelectSvg("chase") }));
vi.mock("@iracedeck/icons/camera-select/chopper.svg", () => ({ default: mockCameraSelectSvg("chopper") }));
vi.mock("@iracedeck/icons/camera-select/cockpit.svg", () => ({ default: mockCameraSelectSvg("cockpit") }));
vi.mock("@iracedeck/icons/camera-select/far-chase.svg", () => ({ default: mockCameraSelectSvg("far-chase") }));
vi.mock("@iracedeck/icons/camera-select/gearbox.svg", () => ({ default: mockCameraSelectSvg("gearbox") }));
vi.mock("@iracedeck/icons/camera-select/gyro.svg", () => ({ default: mockCameraSelectSvg("gyro") }));
vi.mock("@iracedeck/icons/camera-select/lf-susp.svg", () => ({ default: mockCameraSelectSvg("lf-susp") }));
vi.mock("@iracedeck/icons/camera-select/lr-susp.svg", () => ({ default: mockCameraSelectSvg("lr-susp") }));
vi.mock("@iracedeck/icons/camera-select/nose.svg", () => ({ default: mockCameraSelectSvg("nose") }));
vi.mock("@iracedeck/icons/camera-select/pit-lane-2.svg", () => ({ default: mockCameraSelectSvg("pit-lane-2") }));
vi.mock("@iracedeck/icons/camera-select/pit-lane.svg", () => ({ default: mockCameraSelectSvg("pit-lane") }));
vi.mock("@iracedeck/icons/camera-select/rear-chase.svg", () => ({ default: mockCameraSelectSvg("rear-chase") }));
vi.mock("@iracedeck/icons/camera-select/rf-susp.svg", () => ({ default: mockCameraSelectSvg("rf-susp") }));
vi.mock("@iracedeck/icons/camera-select/roll-bar.svg", () => ({ default: mockCameraSelectSvg("roll-bar") }));
vi.mock("@iracedeck/icons/camera-select/rr-susp.svg", () => ({ default: mockCameraSelectSvg("rr-susp") }));
vi.mock("@iracedeck/icons/camera-select/scenic.svg", () => ({ default: mockCameraSelectSvg("scenic") }));
vi.mock("@iracedeck/icons/camera-select/tv1.svg", () => ({ default: mockCameraSelectSvg("tv1") }));
vi.mock("@iracedeck/icons/camera-select/tv2.svg", () => ({ default: mockCameraSelectSvg("tv2") }));
vi.mock("@iracedeck/icons/camera-select/tv3.svg", () => ({ default: mockCameraSelectSvg("tv3") }));

// Focus icon mocks
vi.mock("@iracedeck/icons/camera-focus/focus-your-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-your-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-on-leader.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-on-leader {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-on-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-on-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-on-most-exciting.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-on-most-exciting {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/switch-by-position.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">switch-by-position {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/switch-by-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">switch-by-car-number {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/set-camera-state.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">set-camera-state {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-select-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-select-car {{mainLabel}} {{subLabel}}</svg>',
}));

// focus-select-car (#790): the Race Admin car selector's device-filtered
// profile helpers, reused verbatim to open the selector for this device.
vi.mock("../race-admin/race-admin-selector.js", () => ({
  availableProfilesForDevice: vi.fn(() => ["iRaceDeck Car Selector XL"]),
  deviceProfileEntries: vi.fn(() => [{ name: "iRaceDeck Car Selector XL", label: "iRaceDeck Car Selector" }]),
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  TrkLoc: { NotInWorld: -1, OffTrack: 0, InPitStall: 1, AproachingPits: 2, OnTrack: 3 },
  getCameraGroupsFromSessionInfo: vi.fn(() => []),
  getCamerasInGroup: vi.fn(() => []),
  getCarNumberRawFromSessionInfo: vi.fn(() => null),
  getCarNumberFromSessionInfo: vi.fn(() => null),
  getAllCarNumbers: vi.fn(() => []),
}));

// The camera dial surface consumes the canonical live race order (#803); with
// no translator instance in tests it returns null (the CarIdxPosition fallback).
vi.mock("@iracedeck/sim-events-iracing", () => ({
  getLiveRacePositions: vi.fn(() => null),
}));

const { mockGetGlobalSettings, mockCamera } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn(() => ({})),
  // Stable camera-command surface so tests can assert WHICH SDK command a cycle
  // dispatches (switchNum vs the raw cycle helper). `getCommands` returns this
  // same object every call; `vi.clearAllMocks()` in beforeEach resets its history.
  mockCamera: {
    cycleCamera: vi.fn(() => true),
    cycleSubCamera: vi.fn(() => true),
    cycleCar: vi.fn(() => true),
    cycleDrivingCamera: vi.fn(() => true),
    switchPos: vi.fn(() => true),
    switchNum: vi.fn(() => true),
    setState: vi.fn(() => true),
    focusOnLeader: vi.fn(() => true),
    focusOnIncident: vi.fn(() => true),
    focusOnMostExciting: vi.fn(() => true),
  },
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(), getSessionInfo: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    async onWillAppear(_ev: unknown): Promise<void> {}
    async onWillDisappear(_ev: unknown): Promise<void> {}
    async onDidReceiveSettings(_ev: unknown): Promise<void> {}
  },
  getCommands: vi.fn(() => ({ camera: mockCamera })),
  // #803 dial surface: the host wires a global-settings listener in its
  // constructor; return a no-op unsubscribe so `new CameraControls()` succeeds.
  onGlobalSettingsChange: vi.fn(() => vi.fn()),
  // focus-select-car (#790)
  CAR_SELECTOR_PROFILE: "iRaceDeck Car Selector",
  requestProfileSwitch: vi.fn(),
  resolveProfileNameForDevice: vi.fn((name: string) => `${name} XL`),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: mockGetGlobalSettings,
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
  resolveTitleSettings: vi.fn(
    (
      _svg: unknown,
      _global: unknown,
      overrides: { titleText?: string; showTitle?: boolean } | undefined,
      defaultTitle?: string,
    ) => ({
      showTitle: overrides?.showTitle ?? true,
      showGraphics: true,
      titleText: overrides?.titleText || defaultTitle || "",
      bold: true,
      fontSize: 18,
      position: "bottom" as const,
      customPosition: 0,
    }),
  ),
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
  extractGraphicContent: vi.fn((svg: string) =>
    svg
      .replace(/<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/<desc>[\s\S]*?<\/desc>/, "")
      .trim(),
  ),
  generateTitleText: vi.fn((opts: { text?: string }) => (opts?.text ? `<text>${opts.text}</text>` : "")),
  ICON_BASE_TEMPLATE: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>{{graphicContent}}{{titleContent}}</svg>`,
  parseSvgViewBox: vi.fn((svg: string) => {
    const match = svg.match(/<svg[^>]*viewBox="([^"]+)"/);

    if (!match) return undefined;

    const [x, y, width, height] = match[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);

    return { x, y, width, height };
  }),
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({})),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  // #803 dial surface deps (used by the host-integration dial tests below).
  escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
  getDualPressThresholdMs: () => 500,
  classifyDialRelease: (args: {
    pressStartMs: number;
    nowMs: number;
    rotatedWhilePressed: boolean;
    thresholdMs?: number;
  }) =>
    args.rotatedWhilePressed
      ? "push-turn"
      : args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500)
        ? "long"
        : "short",
}));

describe("CameraControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct setting key", () => {
      expect(CAMERA_GROUPS_SETTING_KEY).toBe("cameraGroupSubset");
    });

    it("should have default camera groups", () => {
      expect(DEFAULT_CAMERA_GROUPS).toContain("Nose");
      expect(DEFAULT_CAMERA_GROUPS).toContain("TV1");
      expect(DEFAULT_CAMERA_GROUPS).toContain("Chase");
      expect(DEFAULT_CAMERA_GROUPS.length).toBeGreaterThan(10);
    });

    it("should have default enabled groups as subset of all groups", () => {
      for (const group of DEFAULT_ENABLED_GROUPS) {
        expect(DEFAULT_CAMERA_GROUPS).toContain(group);
      }
    });

    it("should have all 20 camera groups in CAMERA_GROUP_MAP", () => {
      expect(Object.keys(CAMERA_GROUP_MAP)).toHaveLength(20);
    });

    it("should have correct names for known groups", () => {
      expect(CAMERA_GROUP_MAP[1].name).toBe("Nose");
      expect(CAMERA_GROUP_MAP[9].name).toBe("Cockpit");
      expect(CAMERA_GROUP_MAP[17].name).toBe("TV1");
      expect(CAMERA_GROUP_MAP[20].name).toBe("Scenic");
    });

    it("should have icon SVGs for all groups", () => {
      for (const [, group] of Object.entries(CAMERA_GROUP_MAP)) {
        expect(group.icon).toBeTruthy();
      }
    });
  });

  describe("parseGroupSubset", () => {
    it("should return undefined when no value provided", () => {
      expect(parseGroupSubset(undefined)).toBeUndefined();
    });

    it("should return undefined for invalid JSON string", () => {
      expect(parseGroupSubset("not valid json")).toBeUndefined();
    });

    it("should return undefined when groups key is missing", () => {
      expect(parseGroupSubset({ other: true })).toBeUndefined();
    });

    it("should return enabled groups from object value", () => {
      const result = parseGroupSubset({
        groups: { Nose: true, Gearbox: false, TV1: true },
      });
      expect(result).toContain("Nose");
      expect(result).toContain("TV1");
      expect(result).not.toContain("Gearbox");
    });

    it("should parse JSON string value", () => {
      const result = parseGroupSubset(JSON.stringify({ groups: { Cockpit: true, Chase: true, TV1: false } }));
      expect(result).toContain("Cockpit");
      expect(result).toContain("Chase");
      expect(result).not.toContain("TV1");
    });

    it("should return empty array when all groups explicitly disabled", () => {
      expect(parseGroupSubset({ groups: { Nose: false, TV1: false } })).toEqual([]);
    });
  });

  describe("getEnabledGroupNames", () => {
    it("should use per-action setting when provided", () => {
      const result = getEnabledGroupNames(JSON.stringify({ groups: { Nose: true, TV1: true } }));
      expect(result).toContain("Nose");
      expect(result).toContain("TV1");
      expect(result).toHaveLength(2);
    });

    it("should fall back to legacy global setting when no per-action setting", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_SETTING_KEY]: { groups: { Cockpit: true, Chase: true } },
      });
      const result = getEnabledGroupNames(undefined);
      expect(result).toContain("Cockpit");
      expect(result).toContain("Chase");
      expect(result).toHaveLength(2);
    });

    it("should return DEFAULT_ENABLED_GROUPS when neither per-action nor global setting exists", () => {
      mockGetGlobalSettings.mockReturnValue({});
      expect(getEnabledGroupNames(undefined)).toEqual(DEFAULT_ENABLED_GROUPS);
    });

    it("should prefer per-action setting over global setting", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_SETTING_KEY]: { groups: { Cockpit: true } },
      });
      const result = getEnabledGroupNames(JSON.stringify({ groups: { TV1: true, TV2: true } }));
      expect(result).toContain("TV1");
      expect(result).toContain("TV2");
      expect(result).toHaveLength(2);
    });

    it("should return empty array when per-action setting has all groups disabled", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_SETTING_KEY]: { groups: { Cockpit: true } },
      });
      const result = getEnabledGroupNames(JSON.stringify({ groups: { Nose: false, TV1: false } }));
      expect(result).toEqual([]);
    });
  });

  describe("getNextSelectedGroup", () => {
    const sessionGroups = [
      { groupNum: 1, groupName: "Nose" },
      { groupNum: 2, groupName: "Gearbox" },
      { groupNum: 3, groupName: "Cockpit" },
      { groupNum: 4, groupName: "TV1" },
      { groupNum: 5, groupName: "TV2" },
      { groupNum: 6, groupName: "Chase" },
    ];

    it("should cycle to next enabled group", () => {
      const enabled = ["Nose", "Cockpit", "Chase"];
      expect(getNextSelectedGroup(1, enabled, sessionGroups, 1)).toBe(3);
    });

    it("should cycle to previous enabled group", () => {
      const enabled = ["Nose", "Cockpit", "Chase"];
      expect(getNextSelectedGroup(3, enabled, sessionGroups, -1)).toBe(1);
    });

    it("should wrap around forward", () => {
      const enabled = ["Nose", "Cockpit", "Chase"];
      expect(getNextSelectedGroup(6, enabled, sessionGroups, 1)).toBe(1);
    });

    it("should wrap around backward", () => {
      const enabled = ["Nose", "Cockpit", "Chase"];
      expect(getNextSelectedGroup(1, enabled, sessionGroups, -1)).toBe(6);
    });

    it("should find nearest group when current not in enabled list (forward)", () => {
      const enabled = ["Cockpit", "Chase"];
      expect(getNextSelectedGroup(2, enabled, sessionGroups, 1)).toBe(3);
    });

    it("should find nearest group when current not in enabled list (backward)", () => {
      const enabled = ["Nose", "Cockpit"];
      expect(getNextSelectedGroup(4, enabled, sessionGroups, -1)).toBe(3);
    });

    it("should wrap when current group beyond all enabled (forward)", () => {
      const enabled = ["Nose", "Cockpit"];
      expect(getNextSelectedGroup(6, enabled, sessionGroups, 1)).toBe(1);
    });

    it("should wrap when current group before all enabled (backward)", () => {
      const enabled = ["Cockpit", "Chase"];
      expect(getNextSelectedGroup(1, enabled, sessionGroups, -1)).toBe(6);
    });

    it("should return same group when only one enabled", () => {
      const enabled = ["TV1"];
      expect(getNextSelectedGroup(4, enabled, sessionGroups, 1)).toBe(4);
      expect(getNextSelectedGroup(4, enabled, sessionGroups, -1)).toBe(4);
    });

    it("should return null when no enabled groups exist in session", () => {
      const enabled = ["NonExistent"];
      expect(getNextSelectedGroup(1, enabled, sessionGroups, 1)).toBeNull();
    });

    it("should return null for empty enabled list", () => {
      expect(getNextSelectedGroup(1, [], sessionGroups, 1)).toBeNull();
    });
  });

  describe("generateCameraControlsSvg", () => {
    describe("cycle targets", () => {
      const CYCLE_COMBINATIONS = [
        { target: "cycle-sub-camera", direction: "next" },
        { target: "cycle-sub-camera", direction: "previous" },
        { target: "cycle-car", direction: "next" },
        { target: "cycle-car", direction: "previous" },
        { target: "cycle-driving", direction: "next" },
        { target: "cycle-driving", direction: "previous" },
      ] as const;

      it.each(CYCLE_COMBINATIONS)(
        "should generate a valid data URI for $target / $direction",
        ({ target, direction }) => {
          const result = generateCameraControlsSvg({ target, direction });
          expect(result).toContain("data:image/svg+xml");
        },
      );

      it("should produce different icons for all 6 non-camera cycle combinations", () => {
        const results = CYCLE_COMBINATIONS.map(({ target, direction }) =>
          generateCameraControlsSvg({ target, direction }),
        );
        const uniqueResults = new Set(results);
        expect(uniqueResults.size).toBe(CYCLE_COMBINATIONS.length);
      });

      it("should generate grid icon for cycle-camera/next with default groups", () => {
        mockGetGlobalSettings.mockReturnValue({});
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "cycle-camera", direction: "next" }));
        expect(decoded).toContain("CYCLE CAM");
        // Grid contains camera-select artwork (from default enabled groups)
        expect(decoded).toContain("nose-artwork");
        expect(decoded).toContain("cockpit-artwork");
      });

      it("should generate grid icon for cycle-camera/previous with default groups", () => {
        const decoded = decodeURIComponent(
          generateCameraControlsSvg({ target: "cycle-camera", direction: "previous" }),
        );
        expect(decoded).toContain("CYCLE CAM");
      });

      it("should respect cameraGroupSubset in cycle-camera grid", () => {
        const subset = JSON.stringify({ groups: { Nose: true, TV1: true } });
        const decoded = decodeURIComponent(
          generateCameraControlsSvg({ target: "cycle-camera", direction: "next", cameraGroupSubset: subset }),
        );
        expect(decoded).toContain("nose-artwork");
        expect(decoded).toContain("tv1-artwork");
        expect(decoded).not.toContain("cockpit-artwork");
      });

      it("should include correct icon template for driving/previous", () => {
        const decoded = decodeURIComponent(
          generateCameraControlsSvg({ target: "cycle-driving", direction: "previous" }),
        );
        expect(decoded).toContain("driving-previous");
      });

      it("should thread titleOverrides into the cycle-camera grid label", () => {
        mockGetGlobalSettings.mockReturnValue({});
        const decoded = decodeURIComponent(
          generateCameraControlsSvg({
            target: "cycle-camera",
            direction: "next",
            titleOverrides: { titleText: "CUSTOM CAM" },
          }),
        );
        expect(decoded).toContain("CUSTOM CAM");
        expect(decoded).not.toContain("CYCLE CAM");
      });
    });

    describe("change-camera target", () => {
      it("should generate a valid data URI for change-camera with default group", () => {
        const result = generateCameraControlsSvg({ target: "change-camera" });
        expect(result).toContain("data:image/svg+xml");
      });

      it("should use Cockpit icon for default cameraGroup (9)", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 9 }));
        expect(decoded).toContain("cockpit");
        expect(decoded).toContain("COCKPIT");
      });

      it("should use Nose icon for cameraGroup 1", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 1 }));
        expect(decoded).toContain("nose");
        expect(decoded).toContain("NOSE");
      });

      it("should use TV1 icon for cameraGroup 17", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 17 }));
        expect(decoded).toContain("tv1");
        expect(decoded).toContain("TV1");
      });

      it("should include CAMERA sublabel", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 1 }));
        expect(decoded).toContain("CAMERA");
      });

      it("should fall back to Cockpit for invalid cameraGroup", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 99 }));
        expect(decoded).toContain("cockpit");
      });

      it("should produce different icons for different camera groups", () => {
        const groups = [1, 9, 12, 17];
        const results = groups.map((g) => generateCameraControlsSvg({ target: "change-camera", cameraGroup: g }));
        const uniqueResults = new Set(results);
        expect(uniqueResults.size).toBe(groups.length);
      });
    });

    describe("focus targets", () => {
      const FOCUS_TARGETS = [
        "focus-your-car",
        "focus-on-leader",
        "focus-on-incident",
        "focus-on-most-exciting",
        "switch-by-position",
        "switch-by-car-number",
        "set-camera-state",
      ] as const;

      it.each(FOCUS_TARGETS)("should generate a valid data URI for %s", (target) => {
        const result = generateCameraControlsSvg({ target });
        expect(result).toContain("data:image/svg+xml");
      });

      it("should produce different icons for all 7 focus targets", () => {
        const results = FOCUS_TARGETS.map((target) => generateCameraControlsSvg({ target }));
        const uniqueResults = new Set(results);
        expect(uniqueResults.size).toBe(FOCUS_TARGETS.length);
      });

      it("should include YOUR CAR and FOCUS labels for focus-your-car", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "focus-your-car" }));
        expect(decoded).toContain("YOUR CAR");
        expect(decoded).toContain("FOCUS");
      });

      it("should include LEADER and FOCUS labels for focus-on-leader", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "focus-on-leader" }));
        expect(decoded).toContain("LEADER");
        expect(decoded).toContain("FOCUS");
      });

      it("should include CAM STATE and SET labels for set-camera-state", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "set-camera-state" }));
        expect(decoded).toContain("CAM STATE");
        expect(decoded).toContain("SET");
      });

      it("should include MOST and EXCITING labels for focus-on-most-exciting", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "focus-on-most-exciting" }));
        expect(decoded).toContain("MOST");
        expect(decoded).toContain("EXCITING");
      });
    });
  });

  describe("extractIconArtwork", () => {
    it("should strip svg wrapper, desc, background rect, filter group, and label text", () => {
      const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a4a5a"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="#2a4a5a"/>
    <g transform="translate(40, 27)"><path d="M10 10" fill="#fff"/></g>
    <text x="72" y="138" text-anchor="middle" fill="#fff">NOSE</text>
  </g>
</svg>`;
      const result = extractIconArtwork(input);
      expect(result).toContain('<g transform="translate(40, 27)">');
      expect(result).toContain('<path d="M10 10" fill="#fff"/>');
      expect(result).not.toContain("<svg");
      expect(result).not.toContain("<desc>");
      expect(result).not.toContain("<rect");
      // Label text at y=138 should be stripped
      expect(result).not.toContain('y="138"');
      expect(result).not.toContain("activity-state");
    });

    it("should preserve artwork text elements that are not labels", () => {
      const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="#2a4a5a"/>
    <rect x="36" y="19" width="72" height="52" fill="#333"/>
    <text x="72" y="67" text-anchor="middle" fill="#2a4a5a" font-size="28" font-weight="bold">TV1</text>
    <text x="72" y="138" text-anchor="middle" fill="#fff">{{mainLabel}}</text>
  </g>
</svg>`;
      const result = extractIconArtwork(input);
      expect(result).toContain("TV1");
      expect(result).toContain('y="67"');
      expect(result).not.toContain('y="138"');
    });

    it("should handle multiple artwork groups", () => {
      const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="#2a4a5a"/>
    <g transform="translate(27, 36)"><path d="M1 1" fill="#fff"/></g>
    <g transform="translate(116, 66)"><path d="M2 2" fill="#fff"/></g>
    <text x="72" y="138" text-anchor="middle" fill="#fff">LABEL</text>
  </g>
</svg>`;
      const result = extractIconArtwork(input);
      expect(result).toContain("M1 1");
      expect(result).toContain("M2 2");
    });

    it("should return empty string for minimal SVG with no artwork", () => {
      const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="#2a4a5a"/>
    <text x="72" y="138" fill="#fff">LABEL</text>
  </g>
</svg>`;
      const result = extractIconArtwork(input);
      expect(result.trim()).toBe("");
    });
  });

  describe("computeGridPositions", () => {
    it("should return 1 position at full size for count 1", () => {
      const positions = computeGridPositions(1);
      expect(positions).toHaveLength(1);
      expect(positions[0].size).toBe(144);
      expect(positions[0].x).toBe(0);
      expect(positions[0].y).toBe(0);
    });

    it("should return 2 positions for count 2", () => {
      const positions = computeGridPositions(2);
      expect(positions).toHaveLength(2);
      // Side by side: different x, same y
      expect(positions[0].y).toBe(positions[1].y);
      expect(positions[0].x).not.toBe(positions[1].x);
    });

    it("should return 3 positions in pyramid layout for count 3", () => {
      const positions = computeGridPositions(3);
      expect(positions).toHaveLength(3);
      // 1 on top row, 2 on bottom row
      expect(positions[0].y).toBeLessThan(positions[1].y);
      expect(positions[1].y).toBe(positions[2].y);
    });

    it("should return 4 positions in 2x2 grid for count 4", () => {
      const positions = computeGridPositions(4);
      expect(positions).toHaveLength(4);
      // 2 on top, 2 on bottom
      expect(positions[0].y).toBe(positions[1].y);
      expect(positions[2].y).toBe(positions[3].y);
      expect(positions[0].y).toBeLessThan(positions[2].y);
    });

    it("should return 5 positions in 2+3 layout for count 5", () => {
      const positions = computeGridPositions(5);
      expect(positions).toHaveLength(5);
      // 2 on top row, 3 on bottom row
      expect(positions[0].y).toBe(positions[1].y);
      expect(positions[2].y).toBe(positions[3].y);
      expect(positions[3].y).toBe(positions[4].y);
      expect(positions[0].y).toBeLessThan(positions[2].y);
    });

    it("should return 6 positions in 3+3 layout for count 6", () => {
      const positions = computeGridPositions(6);
      expect(positions).toHaveLength(6);
      // 3 on top row, 3 on bottom row
      expect(positions[0].y).toBe(positions[1].y);
      expect(positions[1].y).toBe(positions[2].y);
      expect(positions[3].y).toBe(positions[4].y);
      expect(positions[4].y).toBe(positions[5].y);
      expect(positions[0].y).toBeLessThan(positions[3].y);
    });

    it("should cap at 6 positions for counts above 6", () => {
      expect(computeGridPositions(7)).toHaveLength(6);
      expect(computeGridPositions(10)).toHaveLength(6);
      expect(computeGridPositions(20)).toHaveLength(6);
    });

    it("should produce consistent sizes within each count", () => {
      for (let count = 2; count <= 7; count++) {
        const positions = computeGridPositions(count);
        const sizes = new Set(positions.map((p) => p.size));
        expect(sizes.size).toBe(1);
      }
    });

    it("should produce larger icons for fewer items", () => {
      const size2 = computeGridPositions(2)[0].size;
      const size4 = computeGridPositions(4)[0].size;
      const size6 = computeGridPositions(6)[0].size;
      expect(size2).toBeGreaterThan(size4);
      expect(size4).toBeGreaterThan(size6);
    });
  });

  describe("generateCycleCameraGridSvg", () => {
    it("should produce a valid data URI", () => {
      const result = generateCycleCameraGridSvg(["Nose", "Cockpit", "Chase"], "next");
      expect(result).toContain("data:image/svg+xml");
    });

    it("should include nested SVGs for each selected group", () => {
      const groups = ["Nose", "Cockpit", "Chase"];
      const decoded = decodeURIComponent(generateCycleCameraGridSvg(groups, "next"));

      // Each group gets a <g transform> thumbnail
      for (const name of groups) {
        expect(decoded).toContain(`${name.toLowerCase().replaceAll(" ", "-")}-artwork`);
      }
    });

    it("should include CYCLE CAM label", () => {
      const decoded = decodeURIComponent(generateCycleCameraGridSvg(["Nose"], "next"));
      expect(decoded).toContain("CYCLE CAM");
    });

    it("should include CYCLE CAM label for previous direction", () => {
      const decoded = decodeURIComponent(generateCycleCameraGridSvg(["Nose"], "previous"));
      expect(decoded).toContain("CYCLE CAM");
      expect(decoded).toContain("nose-artwork");
    });

    it("should not show +N indicator when more than 6 groups", () => {
      const groups = ["Nose", "Cockpit", "Chase", "TV1", "TV2", "TV3", "Blimp"];
      const decoded = decodeURIComponent(generateCycleCameraGridSvg(groups, "next"));
      expect(decoded).not.toContain("+1");
    });

    it("should only include first 6 groups artwork when more than 6", () => {
      const groups = ["Nose", "Cockpit", "Chase", "TV1", "TV2", "TV3", "Blimp"];
      const decoded = decodeURIComponent(generateCycleCameraGridSvg(groups, "next"));
      expect(decoded).toContain("nose-artwork");
      expect(decoded).toContain("tv3-artwork");
      expect(decoded).not.toContain("blimp-artwork");
    });

    it("should fall back to static cycle icon when no groups have icons", () => {
      const result = generateCycleCameraGridSvg(["NonExistent"], "next");
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("data:image/svg+xml");
      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("CAMERA");
      // Should NOT contain grid thumbnails
      expect(decoded).not.toContain("-artwork");
    });

    it("should fall back to static cycle icon for empty group list", () => {
      const result = generateCycleCameraGridSvg([], "next");
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("data:image/svg+xml");
      expect(decoded).toContain("NEXT");
      // Should NOT contain grid thumbnails
      expect(decoded).not.toContain("-artwork");
    });

    it("should produce different results for different group selections", () => {
      const result1 = generateCycleCameraGridSvg(["Nose", "Cockpit"], "next");
      const result2 = generateCycleCameraGridSvg(["Chase", "TV1"], "next");
      expect(result1).not.toBe(result2);
    });

    it("should render custom Title Text from titleOverrides in the grid label", () => {
      const decoded = decodeURIComponent(
        generateCycleCameraGridSvg(["Nose", "Cockpit"], "next", undefined, { titleText: "MY CAM" }),
      );
      expect(decoded).toContain("MY CAM");
      expect(decoded).not.toContain("CYCLE CAM");
    });

    it("should omit the grid label when titleOverrides hides the title", () => {
      const decoded = decodeURIComponent(
        generateCycleCameraGridSvg(["Nose", "Cockpit"], "next", undefined, { showTitle: false }),
      );
      expect(decoded).not.toContain("CYCLE CAM");
    });

    it("should apply titleOverrides on the static fallback icon (no groups with icons)", () => {
      const decoded = decodeURIComponent(
        generateCycleCameraGridSvg(["NonExistent"], "next", undefined, { titleText: "FALLBACK" }),
      );
      expect(decoded).toContain("FALLBACK");
    });
  });

  describe("focus-select-car mode (#790)", () => {
    const focusSelectSettings = {
      target: "focus-select-car" as const,
      direction: "next" as const,
      position: 1,
      carNumber: 0,
      cameraState: 0,
      cameraGroup: 9,
      focusSelectorProfile: "iRaceDeck Car Selector",
    };

    function makeKeyDownEvent(settings: Record<string, unknown>) {
      return {
        action: { id: "ctx-1", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings },
      } as never;
    }

    function makeDialDownEvent(settings: Record<string, unknown>) {
      return {
        action: { id: "ctx-1", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings },
      } as never;
    }

    function makeWillAppearEvent(settings: Record<string, unknown>) {
      return {
        action: {
          id: "ctx-1",
          deviceId: "dev-1",
          deviceType: 2,
          isKey: () => true,
          isDial: () => false,
          setSettings: vi.fn(async () => {}),
          setTitle: vi.fn(async () => {}),
        },
        payload: { settings },
      } as never;
    }

    beforeEach(() => {
      _resetSelectIntents();
    });

    afterEach(() => {
      _resetSelectIntents();
      // Restore the default implementation — a test below overrides this with
      // mockReturnValue (not mockReturnValueOnce), which otherwise leaks into
      // every later test since the top-level beforeEach only calls clearAllMocks.
      vi.mocked(resolveProfileNameForDevice).mockImplementation((name: string) => `${name} XL`);
    });

    it("sets the focus intent and switches to the Car Selector profile on page 0", async () => {
      const action = new CameraControls();
      await action.onKeyDown(makeKeyDownEvent(focusSelectSettings));

      expect(getSelectIntent("dev-1")).toEqual({ action: "focus-camera" });
      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Car Selector XL", 0);
    });

    it("does not set an intent when no selector profile resolves for the device", async () => {
      vi.mocked(resolveProfileNameForDevice).mockReturnValue(undefined);
      const action = new CameraControls();
      await action.onKeyDown(makeKeyDownEvent(focusSelectSettings));

      expect(getSelectIntent("dev-1")).toBeUndefined();
      expect(requestProfileSwitch).not.toHaveBeenCalled();
    });

    it("ignores dial presses for focus-select-car", async () => {
      const action = new CameraControls();
      await action.onDialDown(makeDialDownEvent(focusSelectSettings));

      expect(requestProfileSwitch).not.toHaveBeenCalled();
      expect(getSelectIntent("dev-1")).toBeUndefined();
    });

    it("uses the focus-select-car icon, not the focus-your-car fallback", () => {
      const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "focus-select-car" }));

      // Distinctive content from the mocked focus-select-car.svg module (see
      // the vi.mock near the top of this file) — proves the mode is actually
      // wired into FOCUS_ICONS/FOCUS_TITLES rather than silently falling back.
      expect(decoded).toContain("focus-select-car");
      expect(decoded).toContain("PICK CAR");
      expect(decoded).toContain("FOCUS");
      // Must NOT contain the focus-your-car fallback's distinctive content.
      expect(decoded).not.toContain("focus-your-car");
      expect(decoded).not.toContain("YOUR CAR");
    });

    describe("pushDeviceProfiles", () => {
      it("pushes the device-filtered profile entries on appear when none are stored", async () => {
        const action = new CameraControls();
        const ev = makeWillAppearEvent(focusSelectSettings);

        await action.onWillAppear(ev);

        const setSettings = (ev as { action: { setSettings: ReturnType<typeof vi.fn> } }).action.setSettings;

        expect(setSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            _deviceProfiles: [{ name: "iRaceDeck Car Selector XL", label: "iRaceDeck Car Selector" }],
          }),
        );
      });

      it("does not push device profiles when they already match (echo-loop guard)", async () => {
        const action = new CameraControls();
        const ev = makeWillAppearEvent({
          ...focusSelectSettings,
          _deviceProfiles: [{ name: "iRaceDeck Car Selector XL", label: "iRaceDeck Car Selector" }],
        });

        await action.onWillAppear(ev);

        const setSettings = (ev as { action: { setSettings: ReturnType<typeof vi.fn> } }).action.setSettings;

        expect(setSettings).not.toHaveBeenCalled();
      });

      it("does not push device profiles for a different target", async () => {
        const action = new CameraControls();
        const ev = makeWillAppearEvent({ ...focusSelectSettings, target: "focus-your-car" });

        await action.onWillAppear(ev);

        const setSettings = (ev as { action: { setSettings: ReturnType<typeof vi.fn> } }).action.setSettings;

        expect(setSettings).not.toHaveBeenCalled();
      });
    });
  });
});

// Host integration (#803): the dial branch of the lifecycle handlers routes to
// the CameraDialSurface, and rotation reuses the keypad's own executeCycle SDK
// dispatch (the central mandate — reuse, don't duplicate). The surface's own
// behavior is covered exhaustively in camera-dial-surface.test.ts.
describe("CameraControls dial surface (host integration)", () => {
  function dialContext() {
    return {
      id: "dial-1",
      deviceId: "dev-1",
      deviceType: 2,
      isKey: () => false,
      isDial: () => true,
      setImage: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setSettings: vi.fn(async () => {}),
      setFeedback: vi.fn(async () => {}),
      setTriggerDescription: vi.fn(async () => {}),
    };
  }

  function sdk(action: CameraControls) {
    return (
      action as unknown as {
        sdkController: {
          subscribe: ReturnType<typeof vi.fn>;
          getCurrentTelemetry: ReturnType<typeof vi.fn>;
          getSessionInfo: ReturnType<typeof vi.fn>;
        };
      }
    ).sdkController;
  }

  it("routes a dial willAppear to the surface: pushes the name icon and subscribes to telemetry", async () => {
    const action = new CameraControls();
    const ctx = dialContext();

    await action.onWillAppear({ action: ctx, payload: { settings: { dial: { mode: "car" } } } } as never);

    const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);
    expect(img).toContain("CAMERA");
    expect(img).toContain("CONTROLS");
    expect(sdk(action).subscribe).toHaveBeenCalledWith("dial-1", expect.any(Function));
  });

  it("reuses the keypad cycle dispatch (SDK camera command) on a dial rotation", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 3 });
    vi.mocked(getCommands).mockClear();

    // A cycle mode (camera) routes rotation through the keypad's executeCycle.
    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "camera" } }, ticks: 1 },
    } as never);

    // The rotation reached executeCycle, which resolves the camera command surface.
    expect(getCommands).toHaveBeenCalled();
  });

  it("does not focus for a keypad focus-select-car on a dial press (gesture default is none)", async () => {
    const action = new CameraControls();
    const ctx = dialContext();

    await action.onDialDown({ action: ctx, payload: { settings: { dial: {} } } } as never);
    await action.onDialUp({ action: ctx, payload: { settings: { dial: {} } } } as never);

    expect(requestProfileSwitch).not.toHaveBeenCalled();
  });
});

// Shared root of the reported dial "Cycle Sub-Camera" pace-car stall (#803):
// executeCycle's cycle-sub-camera branch used `cycleSubCamera` → switchPos(carIdx)
// (carIdx-as-position), which iRacing can't resolve for the pace car (no valid
// race position) — unlike the cycle-camera branch, which resolves the focused
// car's number and uses switchNum to KEEP focus. This is shared by the keypad
// and the dial (both go through executeCycle), so the fix lands here and covers
// both surfaces.
describe("cycle-sub-camera keeps focus by car number (pace-car stall #803)", () => {
  function dialContext() {
    return {
      id: "dial-1",
      deviceId: "dev-1",
      deviceType: 2,
      isKey: () => false,
      isDial: () => true,
      setImage: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setSettings: vi.fn(async () => {}),
      setFeedback: vi.fn(async () => {}),
      setTriggerDescription: vi.fn(async () => {}),
    };
  }

  function sdk(action: CameraControls) {
    return (
      action as unknown as {
        sdkController: {
          getCurrentTelemetry: ReturnType<typeof vi.fn>;
          getSessionInfo: ReturnType<typeof vi.fn>;
        };
      }
    ).sdkController;
  }

  beforeEach(() => {
    // This describe is a top-level sibling of `CameraControls`, so that block's
    // beforeEach doesn't reach it — clear the shared hoisted camera mock here so
    // calls don't accumulate across these tests.
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the module defaults so a switched return can't leak forward.
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(null);
    vi.mocked(getCamerasInGroup).mockReturnValue([]);
  });

  it("dispatches switchNum with the focused car's raw number on a dial rotation (pace car focused)", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0); // the pace car's raw number

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: 1 },
    } as never);

    // Keeps the focused (pace) car #0, same group 9, sub-camera 2 → 3. NOT switchPos-by-carIdx.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 9, 3);
    expect(mockCamera.cycleSubCamera).not.toHaveBeenCalled();
  });

  it("decrements the sub-camera on a previous detent", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: -1 },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 9, 1);
  });

  it("the keypad Cycle Sub-Camera uses the SAME switchNum dispatch (shared fix)", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-sub-camera", direction: "next" } },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 9, 3);
    expect(mockCamera.cycleSubCamera).not.toHaveBeenCalled();
  });

  it("falls back to the raw cycle helper when the focused car's number can't be resolved", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 3, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(null);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: 1 },
    } as never);

    expect(mockCamera.cycleSubCamera).toHaveBeenCalledWith(3, 9, 2, 1);
    expect(mockCamera.switchNum).not.toHaveBeenCalled();
  });

  it("focuses the camera the sub-camera carousel resolves — same source as the dial preview, including wrap (#803 strip)", async () => {
    const action = new CameraControls();
    // Focused on the LAST camera (cameraNum 3); the carousel wraps next → cameraNum 1.
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 3 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0);
    vi.mocked(getCamerasInGroup).mockReturnValue([
      { cameraNum: 1, cameraName: "Cockpit" },
      { cameraNum: 2, cameraName: "Roll Bar" },
      { cameraNum: 3, cameraName: "Gyro" },
    ]);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: 1 },
    } as never);

    // Wraps to cameraNum 1 (the carousel target) — NOT the raw 3 + 1 = 4, so the
    // camera the strip previews and the camera the dispatch switches to agree.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 9, 1);
  });

  // The Scenic regression (#803): a large multi-camera group whose active
  // CamCameraNumber is NOT a member of the group's Cameras[] list (Scenic camera
  // numbers are a group-specific block, e.g. 18–22, that the current camera value
  // doesn't index into). Before the recovery fix the carousel returned null
  // neighbours and the dispatch fell back to a synthetic `cameraNum + dir` (31) —
  // not a real camera of the group, so iRacing rejected it and the sub-camera did
  // NOTHING. The dispatch must now target a REAL camera from the list.
  it("targets a real group camera (not a synthetic cameraNum ± 1) when the current camera isn't in the list — Scenic no-op fix", async () => {
    const action = new CameraControls();
    // CamCameraNumber 30 is not in the Scenic camera list [18..22].
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 20, CamCameraNumber: 30 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(44);
    vi.mocked(getCamerasInGroup).mockReturnValue([
      { cameraNum: 18, cameraName: "Scenic 1" },
      { cameraNum: 19, cameraName: "Scenic 2" },
      { cameraNum: 20, cameraName: "Scenic 3" },
      { cameraNum: 21, cameraName: "Scenic 4" },
      { cameraNum: 22, cameraName: "Scenic 5" },
    ]);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: 1 },
    } as never);

    // next detent recovers to the FIRST camera (18), a real member of the group —
    // NOT the synthetic 30 + 1 = 31 that iRacing rejects.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(44, 20, 18);
    expect(mockCamera.switchNum).not.toHaveBeenCalledWith(44, 20, 31);
  });

  it("recovers to the LAST group camera on a previous detent when the current camera isn't in the list", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 20, CamCameraNumber: 30 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(44);
    vi.mocked(getCamerasInGroup).mockReturnValue([
      { cameraNum: 18, cameraName: "Scenic 1" },
      { cameraNum: 19, cameraName: "Scenic 2" },
      { cameraNum: 20, cameraName: "Scenic 3" },
      { cameraNum: 21, cameraName: "Scenic 4" },
      { cameraNum: 22, cameraName: "Scenic 5" },
    ]);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: -1 },
    } as never);

    // previous detent recovers to the LAST camera (22), NOT the synthetic 30 - 1 = 29.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(44, 20, 22);
    expect(mockCamera.switchNum).not.toHaveBeenCalledWith(44, 20, 29);
  });

  it("no-ops for a located single-camera group instead of dispatching a synthetic neighbour", async () => {
    const action = new CameraControls();
    // The focused camera IS the group's only camera — nothing to cycle to. The
    // carousel (and the strip preview) show current-only, so the dispatch must
    // not fall back to the synthetic cameraNum ± 1 iRacing would reject.
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 5, CamCameraNumber: 7 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(44);
    vi.mocked(getCamerasInGroup).mockReturnValue([{ cameraNum: 7, cameraName: "Solo" }]);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: 1 },
    } as never);

    expect(mockCamera.switchNum).not.toHaveBeenCalled();
    expect(mockCamera.cycleSubCamera).not.toHaveBeenCalled();
  });

  it("keeps the raw ± 1 fallback for a genuinely empty camera list (iRacing wraps internally)", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 5, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(44);
    vi.mocked(getCamerasInGroup).mockReturnValue([]);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "sub-camera" } }, ticks: 1 },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(44, 5, 3);
  });
});

// Residual pace-car siblings of the sub-camera fix (#803): cycle-driving used
// cycleDrivingCamera → switchPos(carIdx, group ± 1), passing the focused car's
// INDEX as a race POSITION. The pace car has no classified position, so — just
// like the sub-camera stall — the driving cycle no-ops once the pace car has
// focus. The fix mirrors cycle-camera/cycle-sub-camera: resolve the focused
// car's number and switchNum(carNumberRaw, group ± 1, 0) to KEEP focus while the
// group advances. Shared by the keypad Cycle Driving Camera and the dial's
// driving mode (both go through executeCycle).
describe("cycle-driving keeps focus by car number (pace-car stall #803)", () => {
  function dialContext() {
    return {
      id: "dial-1",
      deviceId: "dev-1",
      deviceType: 2,
      isKey: () => false,
      isDial: () => true,
      setImage: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setSettings: vi.fn(async () => {}),
      setFeedback: vi.fn(async () => {}),
      setTriggerDescription: vi.fn(async () => {}),
    };
  }

  function sdk(action: CameraControls) {
    return (
      action as unknown as {
        sdkController: {
          getCurrentTelemetry: ReturnType<typeof vi.fn>;
          getSessionInfo: ReturnType<typeof vi.fn>;
        };
      }
    ).sdkController;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(null);
  });

  it("dispatches switchNum to keep the focused car and advance the group on a next detent (pace car focused)", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0); // pace car raw #0

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "driving" } }, ticks: 1 },
    } as never);

    // Keeps the focused (pace) car #0, group 9 → 10, sub-camera reset to 0.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 10, 0);
    expect(mockCamera.cycleDrivingCamera).not.toHaveBeenCalled();
  });

  it("decrements the group on a previous detent", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "driving" } }, ticks: -1 },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 8, 0);
  });

  it("the keypad Cycle Driving Camera uses the SAME switchNum dispatch (shared fix)", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(0);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-driving", direction: "next" } },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(0, 10, 0);
    expect(mockCamera.cycleDrivingCamera).not.toHaveBeenCalled();
  });

  it("falls back to the raw cycle helper when the focused car's number can't be resolved", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 3, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(null);

    await action.onDialRotate({
      action: dialContext(),
      payload: { settings: { dial: { mode: "driving" } }, ticks: 1 },
    } as never);

    expect(mockCamera.cycleDrivingCamera).toHaveBeenCalledWith(3, 9, 1);
    expect(mockCamera.switchNum).not.toHaveBeenCalled();
  });
});

// The keypad Cycle Car target had the same carIdx-as-position bug (#803):
// cycleCar → switchPos(carIdx ± 1, 0, 0) treated the car INDEX as a race
// POSITION, so it jumped to whatever car sat at that position and stalled on the
// pace car (no valid position). Cycle Car is keypad-only (the dial split it into
// car-number / race-position modes), so it is exercised through onKeyDown. The
// fix cycles the neighbour by ascending car number (the same computeCarNumberTarget
// ordering the dial car-number mode uses) and focuses it via switchNum.
describe("cycle-car focuses the neighbour by car number (pace-car recovery #803)", () => {
  function sdk(action: CameraControls) {
    return (
      action as unknown as {
        sdkController: {
          getCurrentTelemetry: ReturnType<typeof vi.fn>;
          getSessionInfo: ReturnType<typeof vi.fn>;
        };
      }
    ).sdkController;
  }

  const CARS = [
    { carIdx: 5, carNumber: "7", carNumberRaw: 7, userName: "a" },
    { carIdx: 9, carNumber: "12", carNumberRaw: 12, userName: "b" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(getAllCarNumbers).mockReturnValue([]);
  });

  it("focuses the first car by number when the pace car (excluded from the list) has focus, next detent", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getAllCarNumbers).mockReturnValue(CARS);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-car", direction: "next" } },
    } as never);

    // Pace car (carIdx 0) isn't in the number list → re-enter at the first car
    // (#7), keeping the current camera group 9 / sub-camera 2. NOT switchPos-by-carIdx.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(7, 9, 2);
    expect(mockCamera.cycleCar).not.toHaveBeenCalled();
  });

  it("focuses the last car by number on a previous detent from the pace car", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 0, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getAllCarNumbers).mockReturnValue(CARS);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-car", direction: "previous" } },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(12, 9, 2);
  });

  it("steps to the adjacent car by number for a normally-classified focused car", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 5, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getAllCarNumbers).mockReturnValue(CARS);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-car", direction: "next" } },
    } as never);

    // Focused car #7 (carIdx 5) → next by number → #12.
    expect(mockCamera.switchNum).toHaveBeenCalledWith(12, 9, 2);
  });

  it("skips a car that left the world and focuses the next present one (#885)", async () => {
    // Three cars: #7 (carIdx 5, focused), #12 (carIdx 9), #30 (carIdx 11).
    // carIdx 9 despawned post-race (NotInWorld, lap telemetry -1) — the keypad
    // Cycle Car walk must skip it to #30, same as the dial car-number mode.
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({
      CamCarIdx: 5,
      CamGroupNumber: 9,
      CamCameraNumber: 2,
      CarIdxLapCompleted: [-1, -1, -1, -1, -1, 10, -1, -1, -1, -1, -1, 10],
      CarIdxLapDistPct: [-1, -1, -1, -1, -1, 0.5, -1, -1, -1, -1, -1, 0.6],
      CarIdxTrackSurface: [-1, -1, -1, -1, -1, 3, -1, -1, -1, -1, -1, 3],
    });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getAllCarNumbers).mockReturnValue([
      ...CARS,
      { carIdx: 11, carNumber: "30", carNumberRaw: 30, userName: "c" },
    ]);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-car", direction: "next" } },
    } as never);

    expect(mockCamera.switchNum).toHaveBeenCalledWith(30, 9, 2);
  });

  it("does nothing when every other car has left the world — no raw-cycle fallback (#885)", async () => {
    // Cars exist in session info but the only other one (#12, carIdx 9)
    // despawned. The raw cycleCar fallback is reserved for the true
    // out-of-session case (empty car list) — an all-absent field must no-op,
    // matching the dial's no-fallback contract.
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({
      CamCarIdx: 5,
      CamGroupNumber: 9,
      CamCameraNumber: 2,
      CarIdxLapCompleted: [-1, -1, -1, -1, -1, 10, -1, -1, -1, -1],
      CarIdxLapDistPct: [-1, -1, -1, -1, -1, 0.5, -1, -1, -1, -1],
      CarIdxTrackSurface: [-1, -1, -1, -1, -1, 3, -1, -1, -1, -1],
    });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getAllCarNumbers).mockReturnValue(CARS);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-car", direction: "next" } },
    } as never);

    expect(mockCamera.switchNum).not.toHaveBeenCalled();
    expect(mockCamera.cycleCar).not.toHaveBeenCalled();
  });

  it("falls back to cycleCar when the field is empty (out of session)", async () => {
    const action = new CameraControls();
    sdk(action).getCurrentTelemetry.mockReturnValue({ CamCarIdx: 3, CamGroupNumber: 9, CamCameraNumber: 2 });
    sdk(action).getSessionInfo.mockReturnValue({});
    vi.mocked(getAllCarNumbers).mockReturnValue([]);

    await action.onKeyDown({
      action: { id: "k1" },
      payload: { settings: { target: "cycle-car", direction: "next" } },
    } as never);

    expect(mockCamera.cycleCar).toHaveBeenCalledWith(3, 1);
    expect(mockCamera.switchNum).not.toHaveBeenCalled();
  });
});
