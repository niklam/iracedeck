import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_GROUPS_GLOBAL_KEY,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  generateCameraControlsSvg,
  getEnabledGroupNames,
  getNextSelectedGroup,
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

// Camera select icon mocks
vi.mock("@iracedeck/icons/camera-select/blimp.svg", () => ({ default: "<svg>blimp {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/chase.svg", () => ({ default: "<svg>chase {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/chopper.svg", () => ({ default: "<svg>chopper {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/cockpit.svg", () => ({ default: "<svg>cockpit {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/far-chase.svg", () => ({ default: "<svg>far-chase {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/gearbox.svg", () => ({ default: "<svg>gearbox {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/gyro.svg", () => ({ default: "<svg>gyro {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/lf-susp.svg", () => ({ default: "<svg>lf-susp {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/lr-susp.svg", () => ({ default: "<svg>lr-susp {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/nose.svg", () => ({ default: "<svg>nose {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/pit-lane-2.svg", () => ({ default: "<svg>pit-lane-2 {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/pit-lane.svg", () => ({ default: "<svg>pit-lane {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/rear-chase.svg", () => ({ default: "<svg>rear-chase {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/rf-susp.svg", () => ({ default: "<svg>rf-susp {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/roll-bar.svg", () => ({ default: "<svg>roll-bar {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/rr-susp.svg", () => ({ default: "<svg>rr-susp {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/scenic.svg", () => ({ default: "<svg>scenic {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/tv1.svg", () => ({ default: "<svg>tv1 {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/tv2.svg", () => ({ default: "<svg>tv2 {{mainLabel}}</svg>" }));
vi.mock("@iracedeck/icons/camera-select/tv3.svg", () => ({ default: "<svg>tv3 {{mainLabel}}</svg>" }));

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
vi.mock("@iracedeck/icons/camera-focus/focus-on-exiting.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-on-exiting {{mainLabel}} {{subLabel}}</svg>',
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
      focusOnExiting: vi.fn(() => true),
    },
  })),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: mockGetGlobalSettings,
  LogLevel: { Info: 2 },
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
    it("should have correct global key", () => {
      expect(CAMERA_GROUPS_GLOBAL_KEY).toBe("cameraGroupSubset");
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
  });

  describe("getEnabledGroupNames", () => {
    it("should return DEFAULT_ENABLED_GROUPS when no global setting", () => {
      mockGetGlobalSettings.mockReturnValue({});
      expect(getEnabledGroupNames()).toEqual(DEFAULT_ENABLED_GROUPS);
    });

    it("should return enabled groups from global settings (object)", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_GLOBAL_KEY]: {
          groups: { Nose: true, Gearbox: false, TV1: true },
        },
      });
      const result = getEnabledGroupNames();
      expect(result).toContain("Nose");
      expect(result).toContain("TV1");
      expect(result).not.toContain("Gearbox");
    });

    it("should parse JSON string from global settings", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_GLOBAL_KEY]: JSON.stringify({
          groups: { Cockpit: true, Chase: true, TV1: false },
        }),
      });
      const result = getEnabledGroupNames();
      expect(result).toContain("Cockpit");
      expect(result).toContain("Chase");
      expect(result).not.toContain("TV1");
    });

    it("should fall back to defaults for invalid JSON string", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_GLOBAL_KEY]: "not valid json",
      });
      expect(getEnabledGroupNames()).toEqual(DEFAULT_ENABLED_GROUPS);
    });

    it("should fall back to defaults when all groups disabled", () => {
      mockGetGlobalSettings.mockReturnValue({
        [CAMERA_GROUPS_GLOBAL_KEY]: {
          groups: { Nose: false, TV1: false },
        },
      });
      expect(getEnabledGroupNames()).toEqual(DEFAULT_ENABLED_GROUPS);
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
        { target: "cycle-camera", direction: "next" },
        { target: "cycle-camera", direction: "previous" },
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

      it("should produce different icons for all 8 cycle combinations", () => {
        const results = CYCLE_COMBINATIONS.map(({ target, direction }) =>
          generateCameraControlsSvg({ target, direction }),
        );
        const uniqueResults = new Set(results);
        expect(uniqueResults.size).toBe(CYCLE_COMBINATIONS.length);
      });

      it("should include NEXT CAMERA labels for cycle-camera/next", () => {
        const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "cycle-camera", direction: "next" }));
        expect(decoded).toContain("NEXT");
        expect(decoded).toContain("CAMERA");
      });

      it("should include PREV CAMERA labels for cycle-camera/previous", () => {
        const decoded = decodeURIComponent(
          generateCameraControlsSvg({ target: "cycle-camera", direction: "previous" }),
        );
        expect(decoded).toContain("PREV");
        expect(decoded).toContain("CAMERA");
      });

      it("should include correct icon template for driving/previous", () => {
        const decoded = decodeURIComponent(
          generateCameraControlsSvg({ target: "cycle-driving", direction: "previous" }),
        );
        expect(decoded).toContain("driving-previous");
      });
    });

    describe("focus targets", () => {
      const FOCUS_TARGETS = [
        "focus-your-car",
        "focus-on-leader",
        "focus-on-incident",
        "focus-on-exiting",
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
    });
  });
});
