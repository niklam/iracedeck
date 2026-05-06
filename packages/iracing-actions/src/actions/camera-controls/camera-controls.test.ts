import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_GROUP_MAP,
  CAMERA_GROUPS_SETTING_KEY,
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

vi.mock("@iracedeck/iracing-sdk", () => ({
  getCameraGroupsFromSessionInfo: vi.fn(() => []),
  getCarNumberRawFromSessionInfo: vi.fn(() => null),
}));

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn(() => ({})),
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
  },
  getCommands: vi.fn(() => ({
    camera: {
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
  })),
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
  extractGraphicContent: vi.fn((svg: string) =>
    svg
      .replace(/<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/<desc>[\s\S]*?<\/desc>/, "")
      .trim(),
  ),
  generateTitleText: vi.fn(() => ""),
  ICON_BASE_TEMPLATE: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>{{graphicContent}}{{titleContent}}</svg>`,
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({})),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
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
  });
});
