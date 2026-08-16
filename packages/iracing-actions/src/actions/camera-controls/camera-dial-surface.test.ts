import { applyBindingWarning } from "@iracedeck/deck-core";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeCarNumberTarget } from "../../shared/car-cycling.js";
import {
  buildTriggerDescription,
  CameraDialSurface,
  clockwiseDirection,
  computeRacePositionTarget,
  DIAL_MODES,
  DialSettings,
  renderCameraCarousel,
  renderCarCarousel,
  renderRacePositionCarousel,
  renderSubCameraCarousel,
  wrapPosition,
} from "./camera-dial-surface.js";
import { SUB_CAMERA_BINDING_KEY_LIST, SUB_CAMERA_BINDING_KEYS } from "./sub-camera-bindings.js";

const { mockGroups, mockCameras, mockCarNumber, mockCarNumberByIdx, mockCarNumberRawByIdx, mockAllCars } = vi.hoisted(
  () => ({
    // Mutable session lookups the SDK helper mocks read, so tests can flip
    // in-session / out-of-session and change the focused car per case.
    mockGroups: {
      value: [
        { groupNum: 1, groupName: "Nose" },
        { groupNum: 9, groupName: "Cockpit" },
        { groupNum: 12, groupName: "Chase" },
      ] as Array<{ groupNum: number; groupName: string }>,
    },
    // The cameras getCamerasInGroup returns for the focused group (sub-camera mode).
    mockCameras: { value: [] as Array<{ cameraNum: number; cameraName: string }> },
    mockCarNumber: { value: "42" as string | null },
    // When set, getCarNumberFromSessionInfo resolves per carIdx (race-position tests).
    mockCarNumberByIdx: { value: null as Record<number, string> | null },
    // When set, getCarNumberRawFromSessionInfo resolves per carIdx (race-position
    // EXECUTION tests — the raw number is what focusCarNumber is dispatched with).
    mockCarNumberRawByIdx: { value: null as Record<number, number> | null },
    mockAllCars: {
      value: [
        { carIdx: 1, carNumber: "3", carNumberRaw: 3, userName: "a" },
        { carIdx: 3, carNumber: "42", carNumberRaw: 42, userName: "b" },
        { carIdx: 5, carNumber: "99", carNumberRaw: 99, userName: "c" },
      ] as Array<{ carIdx: number; carNumber: string; carNumberRaw: number; userName: string }>,
    },
  }),
);

vi.mock("@iracedeck/deck-core", () => ({
  // push-turn when rotated while held, else long/short vs the threshold.
  classifyDialRelease: (args: {
    pressStartMs: number;
    nowMs: number;
    rotatedWhilePressed: boolean;
    thresholdMs?: number;
  }) => {
    if (args.rotatedWhilePressed) return "push-turn";

    return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
  },
  getDualPressThresholdMs: () => 500,
  applyBindingWarning: vi.fn((content: string) => `${content}<binding-warning/>`),
  escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  svgToDataUri: (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`,
}));

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/iracing-sdk")>();

  return {
    TrkLoc: actual.TrkLoc,
    // The REAL track-order primitive (#886): the dial's track-order mode is a
    // composition over it, and the tests below assert real on-track geometry.
    findNearestCarOnTrack: actual.findNearestCarOnTrack,
    // The REAL in-world predicate (#968) for the same reason — and the primitive
    // above consumes it, so a stub here would silently change its behaviour.
    carInWorld: actual.carInWorld,
    getCameraGroupsFromSessionInfo: vi.fn(() => mockGroups.value),
    getCamerasInGroup: vi.fn(() => mockCameras.value),
    getCarNumberFromSessionInfo: vi.fn((_s: unknown, carIdx: number) =>
      mockCarNumberByIdx.value ? (mockCarNumberByIdx.value[carIdx] ?? null) : mockCarNumber.value,
    ),
    getCarNumberRawFromSessionInfo: vi.fn((_s: unknown, carIdx: number) =>
      mockCarNumberRawByIdx.value ? (mockCarNumberRawByIdx.value[carIdx] ?? null) : null,
    ),
    getAllCarNumbers: vi.fn(() => mockAllCars.value),
  };
});

/** Fake dial (encoder) action context. */
function dialContext(id: string) {
  return {
    id,
    isKey: () => false,
    isDial: () => true,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
  };
}

const TELEMETRY = { CamGroupNumber: 9, CamCarIdx: 3 };

/**
 * An on-track field for the track-order tests (#886). Competitors by number:
 * #3 (carIdx 1), #42 (carIdx 3, focused), #99 (carIdx 5). On the ROAD the
 * order is the opposite of the number order: #42 at 0.30 is followed by #3 at
 * 0.55, then #99 at 0.80 (which wraps back to #42) — so a number-ordered walk
 * and a track-ordered walk land on DIFFERENT cars.
 */
const ON_TRACK = {
  CamCarIdx: 3,
  CamGroupNumber: 9,
  CarIdxLapDistPct: [-1, 0.55, -1, 0.3, -1, 0.8],
  CarIdxTrackSurface: [-1, 3, -1, 3, -1, 3],
};

/**
 * Matches a strip text element at one of the renderers' side slots. The x
 * coordinate is computed the SAME way production does (`width * factor`), so
 * the assertion pins WHICH side a preview is drawn on — the left side is the
 * counter-clockwise detent's target, the right side the clockwise one (#884).
 */
function sideText(xFactor: number, content: string): RegExp {
  return new RegExp(`<text x="${200 * xFactor}"[^>]*>${content}<`);
}

function makeHost(over: Partial<Record<string, unknown>> = {}) {
  return {
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getTelemetry: vi.fn(() => TELEMETRY as never),
    getSessionInfo: vi.fn(() => ({}) as unknown),
    getRacePositions: vi.fn(() => null as number[] | null),
    getEnabledCameraGroups: vi.fn(() => ["Nose", "Cockpit", "Chase"]),
    getGroupGlyph: vi.fn((name: string) => ({ width: 68, height: 68, artwork: `<path data-group="${name}"/>` })),
    cycle: vi.fn(),
    isBindingMissing: vi.fn(() => false),
    focusCarNumber: vi.fn(),
    focusMyCar: vi.fn(),
    changeCamera: vi.fn(),
    focusOnLeader: vi.fn(),
    focusOnIncident: vi.fn(),
    focusOnMostExciting: vi.fn(),
    ...over,
  };
}

function dial(over: Record<string, unknown> = {}) {
  return DialSettings.parse(over);
}

beforeEach(() => {
  mockGroups.value = [
    { groupNum: 1, groupName: "Nose" },
    { groupNum: 9, groupName: "Cockpit" },
    { groupNum: 12, groupName: "Chase" },
  ];
  mockCameras.value = [];
  mockCarNumber.value = "42";
  mockCarNumberByIdx.value = null;
  mockCarNumberRawByIdx.value = null;
  mockAllCars.value = [
    { carIdx: 1, carNumber: "3", carNumberRaw: 3, userName: "a" },
    { carIdx: 3, carNumber: "42", carNumberRaw: 42, userName: "b" },
    { carIdx: 5, carNumber: "99", carNumberRaw: 99, userName: "c" },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("camera dial-surface pure helpers", () => {
  describe("wrapPosition", () => {
    it("wraps forward and backward within the field", () => {
      expect(wrapPosition(2, 1, 3)).toBe(3);
      expect(wrapPosition(3, 1, 3)).toBe(1); // wrap forward at the end
      expect(wrapPosition(1, -1, 3)).toBe(3); // wrap backward at the start
    });
  });

  describe("computeCarNumberTarget", () => {
    const cars = [
      { carIdx: 1, carNumber: "3", carNumberRaw: 3 },
      { carIdx: 3, carNumber: "42", carNumberRaw: 42 },
      { carIdx: 5, carNumber: "99", carNumberRaw: 99 },
    ];

    it("steps to the next / previous car by ascending number", () => {
      expect(computeCarNumberTarget(3, cars, "next")?.carNumberRaw).toBe(99);
      expect(computeCarNumberTarget(3, cars, "previous")?.carNumberRaw).toBe(3);
    });

    it("wraps at the ends of the field", () => {
      expect(computeCarNumberTarget(5, cars, "next")?.carNumberRaw).toBe(3);
      expect(computeCarNumberTarget(1, cars, "previous")?.carNumberRaw).toBe(99);
    });

    it("starts from an end when the focused car is not in the list", () => {
      expect(computeCarNumberTarget(99, cars, "next")?.carNumberRaw).toBe(3);
      expect(computeCarNumberTarget(undefined, cars, "previous")?.carNumberRaw).toBe(99);
    });

    it("returns null for an empty field", () => {
      expect(computeCarNumberTarget(3, [], "next")).toBeNull();
    });

    it("walks past cars not in the world to the next present one (#885)", () => {
      // carIdx5 (#99) left the world post-race: next from #42 skips it and
      // wraps to #3 instead of dispatching a dead switch.
      expect(computeCarNumberTarget(3, cars, "next", (idx) => idx !== 5)?.carNumberRaw).toBe(3);
      // Same walk backward: previous from #42 skips absent carIdx1 (#3).
      expect(computeCarNumberTarget(3, cars, "previous", (idx) => idx !== 1)?.carNumberRaw).toBe(99);
    });

    it("returns null when no other car is present in the world (#885)", () => {
      expect(computeCarNumberTarget(3, cars, "next", (idx) => idx === 3)).toBeNull();
    });
  });

  describe("computeRacePositionTarget", () => {
    // carIdx→position: idx1=P3, idx2=P1, idx3=P2.
    const order = [0, 3, 1, 2];

    it("steps the focused car to the next / previous position", () => {
      expect(computeRacePositionTarget(3, order, "next")?.targetPosition).toBe(3);
      expect(computeRacePositionTarget(3, order, "previous")?.targetPosition).toBe(1);
    });

    it("wraps at the ends of the field", () => {
      expect(computeRacePositionTarget(2, order, "previous")?.targetPosition).toBe(3); // P1 prev → P3
      expect(computeRacePositionTarget(1, order, "next")?.targetPosition).toBe(1); // P3 next → P1
    });

    it("returns null with no order (or an out-of-range focused car)", () => {
      expect(computeRacePositionTarget(3, null, "next")).toBeNull();
      expect(computeRacePositionTarget(undefined, order, "next")).toBeNull();
      expect(computeRacePositionTarget(-1, order, "next")).toBeNull();
    });

    it("recovers into the running order when the focused car is unclassified (pace/safety car)", () => {
      // order[0] === 0 (unclassified — pace car / safety car / car not in the
      // order). A detent must still act: next → the leader (P1), previous →
      // last place (maxPosition). No currentPosition, so no position badge.
      expect(computeRacePositionTarget(0, order, "next")).toEqual({
        currentPosition: null,
        targetPosition: 1,
        maxPosition: 3,
      });
      expect(computeRacePositionTarget(0, order, "previous")).toEqual({
        currentPosition: null,
        targetPosition: 3,
        maxPosition: 3,
      });
    });

    it("walks past positions whose car left the world to the next present one (#885)", () => {
      // Post-race: carIdx2 (P1) towed out but keeps its frozen rank. previous
      // from P2 skips the dead P1 and wraps to P3 — the next present car.
      expect(computeRacePositionTarget(3, order, "previous", (idx) => idx !== 2)).toEqual({
        currentPosition: 2,
        targetPosition: 3,
        maxPosition: 3,
      });
      // Forward too: next from P2 skips an absent P3 (carIdx1) and wraps to P1.
      expect(computeRacePositionTarget(3, order, "next", (idx) => idx !== 1)).toEqual({
        currentPosition: 2,
        targetPosition: 1,
        maxPosition: 3,
      });
    });

    it("returns null when no other position's car is present in the world (#885)", () => {
      expect(computeRacePositionTarget(3, order, "next", (idx) => idx === 3)).toBeNull();
    });

    it("recovery re-entry also walks past absent cars (#885)", () => {
      // Focused pace car (unclassified); the leader (carIdx2, P1) left the
      // world, so next re-enters at P2 instead of the dead P1.
      expect(computeRacePositionTarget(0, order, "next", (idx) => idx !== 2)).toEqual({
        currentPosition: null,
        targetPosition: 2,
        maxPosition: 3,
      });
    });
  });

  describe("clockwiseDirection", () => {
    it("maps clockwise to previous for the number-primary modes — the strip's number goes down (#884, #973)", () => {
      for (const mode of ["race-position", "car-number"] as const) {
        expect(clockwiseDirection(mode, false)).toBe("previous");
      }

      for (const mode of ["camera", "sub-camera", "track-order", "driving"] as const) {
        expect(clockwiseDirection(mode, false)).toBe("next");
      }
    });

    it("maps clockwise to next for track-order — the car AHEAD on the road (#886)", () => {
      // "next" IS ahead in track order (the direction of travel), so clockwise
      // lands on the car ahead just like race-position's flipped default does.
      expect(clockwiseDirection("track-order", false)).toBe("next");
      expect(clockwiseDirection("track-order", true)).toBe("previous");
    });

    it("flips the active mode's default mapping when reverseRotation is set", () => {
      // The number-primary modes reversed = the pre-flip feel, where a clockwise
      // detent raises the number (race-position pre-#884, car-number pre-#973).
      expect(clockwiseDirection("race-position", true)).toBe("next");
      expect(clockwiseDirection("car-number", true)).toBe("next");
      expect(clockwiseDirection("camera", true)).toBe("previous");
      expect(clockwiseDirection("sub-camera", true)).toBe("previous");
      expect(clockwiseDirection("driving", true)).toBe("previous");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the cycled target on rotate and rides the long-press on push", () => {
      const desc = buildTriggerDescription(
        dial({ mode: "car-number", pressAction: "focus-my-car", longPressAction: "focus-on-leader" }),
      );

      expect(desc.rotate).toBe("Cycle Cars by Number");
      expect(desc.push).toBe("Focus My Car (hold: Focus on Leader)");
    });

    it("names the race-position target and maps the touch slots", () => {
      const desc = buildTriggerDescription(
        dial({ mode: "race-position", tapAction: "focus-on-incident", longTouchAction: "focus-on-most-exciting" }),
      );

      expect(desc.rotate).toBe("Cycle Cars by Position");
      expect(desc.touch).toBe("Focus on Incident");
      expect(desc.longTouch).toBe("Focus on Most Exciting");
    });

    it("names the track-order target (#886)", () => {
      expect(buildTriggerDescription(dial({ mode: "track-order" })).rotate).toBe("Cycle Cars by Track Order");
    });
  });

  describe("renderCameraCarousel", () => {
    const colors = { border: "#111", label: "#222", value: "#333", background: "#0d0d0d" };

    it("draws the mode-name title, the centre group name, and the side glyphs", () => {
      const svg = renderCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "CAMERA",
        identityLabel: "CAMERA",
        current: { name: "Cockpit", glyph: { width: 68, height: 68, artwork: '<path data-g="Cockpit"/>' } },
        left: { name: "Nose", glyph: { width: 68, height: 68, artwork: '<path data-g="Nose"/>' } },
        right: { name: "Chase", glyph: { width: 68, height: 68, artwork: '<path data-g="Chase"/>' } },
      });

      expect(svg).toContain(">CAMERA<"); // mode-name title (top line)
      expect(svg).toContain(">COCKPIT<");
      expect(svg).toContain('data-g="Cockpit"');
      expect(svg).toContain('data-g="Nose"');
      expect(svg).toContain('data-g="Chase"');
    });

    it("renders a side name when a group has no glyph", () => {
      const svg = renderCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "CAMERA",
        identityLabel: "CAMERA",
        current: { name: "Cockpit", glyph: null },
        left: { name: "Scenic", glyph: null },
        right: null,
      });

      expect(svg).toContain(">SCENIC<");
      expect(svg).toContain(">COCKPIT<");
    });

    it("renders current only (no side glyphs) when left/right are null — the driving mode shape", () => {
      const svg = renderCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "DRIVING CAM",
        identityLabel: "DRIVING",
        current: { name: "Cockpit", glyph: { width: 68, height: 68, artwork: '<path data-g="Cockpit"/>' } },
        left: null,
        right: null,
      });

      expect(svg).toContain(">DRIVING CAM<");
      expect(svg).toContain(">COCKPIT<");
      expect(svg).toContain('data-g="Cockpit"');
    });

    it("falls back to the identity label with no current group", () => {
      const svg = renderCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "CAMERA",
        identityLabel: "CAMERA",
        current: null,
        left: null,
        right: null,
      });

      expect(svg).toContain(">CAMERA<");
    });
  });

  describe("renderSubCameraCarousel", () => {
    const colors = { border: "#111", label: "#222", value: "#333", background: "#0d0d0d" };

    it("draws the mode-name title, the centre camera name, and the side camera names", () => {
      const svg = renderSubCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "SUB-CAMERA",
        identityLabel: "SUB CAM",
        current: "Roll Bar",
        left: "Cockpit",
        right: "Gyro",
      });

      expect(svg).toContain(">SUB-CAMERA<"); // mode-name title
      expect(svg).toContain(">ROLL BAR<"); // current camera (uppercased)
      expect(svg).toContain(">COCKPIT<"); // left-side camera
      expect(svg).toContain(">GYRO<"); // right-side camera
    });

    it("falls back to the identity label with no current camera", () => {
      const svg = renderSubCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "SUB-CAMERA",
        identityLabel: "SUB CAM",
        current: null,
        left: null,
        right: null,
      });

      expect(svg).toContain(">SUB CAM<");
    });
  });

  describe("renderCarCarousel", () => {
    const colors = { border: "#111", label: "#222", value: "#333", background: "#0d0d0d" };

    it("draws the mode-name title, the centre car number, and the side numbers", () => {
      const svg = renderCarCarousel({
        width: 200,
        height: 100,
        colors,
        title: "CAR #",
        identityLabel: "CAR #",
        center: "42",
        left: "3",
        right: "99",
      });

      expect(svg).toContain(">CAR #<"); // mode-name title
      expect(svg).toContain(">#42<");
      expect(svg).toContain(">#3<");
      expect(svg).toContain(">#99<");
      expect(svg).not.toMatch(/>P\d/); // never a position badge — car-number mode is number-primary
      expect(svg).not.toMatch(/AHEAD|BEHIND/); // no side captions unless asked for
    });

    it("draws the side captions beneath the side numbers when given (track-order, #886)", () => {
      const svg = renderCarCarousel({
        width: 200,
        height: 100,
        colors,
        title: "TRACK ORDER",
        identityLabel: "TRACK ORDER",
        center: "42",
        left: "99",
        right: "3",
        sideCaptions: { left: "BEHIND", right: "AHEAD" },
      });

      expect(svg).toContain(">TRACK ORDER<");
      expect(svg).toContain(">#42<");
      // Each caption sits on the SAME side as its number (left x = 0.16 w, right x = 0.84 w).
      expect(svg).toMatch(sideText(0.16, "#99"));
      expect(svg).toMatch(sideText(0.16, "BEHIND"));
      expect(svg).toMatch(sideText(0.84, "#3"));
      expect(svg).toMatch(sideText(0.84, "AHEAD"));
    });

    it("draws no caption on a side that has no car to preview", () => {
      const svg = renderCarCarousel({
        width: 200,
        height: 100,
        colors,
        title: "TRACK ORDER",
        identityLabel: "TRACK ORDER",
        center: "42",
        left: null,
        right: "3",
        sideCaptions: { left: "BEHIND", right: "AHEAD" },
      });

      expect(svg).not.toContain("BEHIND");
      expect(svg).toMatch(sideText(0.84, "AHEAD"));
    });

    it("falls back to the identity label with no focused car", () => {
      const svg = renderCarCarousel({
        width: 200,
        height: 100,
        colors,
        title: "CAR #",
        identityLabel: "CAR #",
        center: null,
        left: null,
        right: null,
      });

      expect(svg).toContain(">CAR #<");
    });
  });

  describe("renderRacePositionCarousel", () => {
    const colors = { border: "#111", label: "#222", value: "#333", background: "#0d0d0d" };

    it("draws the mode-name title, the centre POSITION as primary, and the car number as secondary", () => {
      const svg = renderRacePositionCarousel({
        width: 200,
        height: 100,
        colors,
        title: "POSITION",
        identityLabel: "POSITION",
        centerPosition: 4,
        centerCarNumber: "42",
        leftPosition: 3,
        rightPosition: 5,
      });

      expect(svg).toContain(">POSITION<"); // mode-name title
      expect(svg).toContain(">P4<"); // primary: the focused car's position
      expect(svg).toContain(">#42<"); // secondary: the focused car's number
      expect(svg).toContain(">P3<"); // dimmed left-side preview
      expect(svg).toContain(">P5<"); // dimmed right-side preview
      expect(svg).not.toMatch(/>#3<|>#5</); // side previews are positions, never car numbers
    });

    it("falls back to a number-only centre when the focused car has no classified position", () => {
      const svg = renderRacePositionCarousel({
        width: 200,
        height: 100,
        colors,
        title: "POSITION",
        identityLabel: "POSITION",
        centerPosition: null,
        centerCarNumber: "0",
        leftPosition: 3,
        rightPosition: 1,
      });

      expect(svg).toContain(">#0<"); // number-only centre, no lying P badge for the unclassified car
      // The side previews still recover to a real position and show it dimmed.
      expect(svg).toContain(">P3<");
      expect(svg).toContain(">P1<");
    });

    it("falls back to the identity label with no focused car", () => {
      const svg = renderRacePositionCarousel({
        width: 200,
        height: 100,
        colors,
        title: "POSITION",
        identityLabel: "POSITION",
        centerPosition: null,
        centerCarNumber: null,
        leftPosition: null,
        rightPosition: null,
      });

      expect(svg).toContain(">POSITION<");
    });
  });
});

describe("CameraDialSurface", () => {
  describe("legacy settings mapping", () => {
    it("maps the pre-rework mode 'car' to 'car-number' without dropping other fields", () => {
      const parsed = DialSettings.parse({ mode: "car", pressAction: "focus-my-car", longTouchAction: "change-camera" });

      expect(parsed.mode).toBe("car-number");
      expect(parsed.pressAction).toBe("focus-my-car");
      expect(parsed.longTouchAction).toBe("change-camera");
    });

    it("accepts the track-order mode (#886)", () => {
      expect(DialSettings.parse({ mode: "track-order" }).mode).toBe("track-order");
    });

    it("has a communication-method record for every dial mode (comms-catalog `camera-focus-dial`, #612)", () => {
      // The catalog is a loose object literal, so a new DIAL_MODES member is not
      // a compile error there — guard the per-mode record here instead.
      const comms = JSON.parse(readFileSync(new URL("../data/action-comms.json", import.meta.url), "utf-8")) as Record<
        string,
        Record<string, unknown>
      >;

      // Sub-Camera is the one keyboard-driven mode (#852): iRacing's camera
      // switch broadcasts never select a sub-camera, so it taps the sim's own
      // bindings while every other mode stays an SDK command.
      for (const mode of DIAL_MODES) {
        const record = comms["camera-focus-dial"][mode] as { method?: string } | undefined;

        expect(record, `camera-focus-dial has no entry for dial mode "${mode}"`).toBeDefined();
        expect(record?.method, `unexpected communication method for dial mode "${mode}"`).toBe(
          mode === "sub-camera" ? "keybind" : "api",
        );
      }

      expect(comms["camera-focus-dial"]["sub-camera"]).toEqual({
        method: "keybind",
        binding: { scope: "global", keys: [SUB_CAMERA_BINDING_KEYS.next, SUB_CAMERA_BINDING_KEYS.previous] },
      });
    });

    it("defaults to car-number for a fresh dial", () => {
      expect(DialSettings.parse({}).mode).toBe("car-number");
    });
  });

  describe("reverseRotation setting (#884)", () => {
    it("defaults to false so an untouched dial gets the new default mapping", () => {
      expect(DialSettings.parse({}).reverseRotation).toBe(false);
    });

    it("coerces the sdpi checkbox string forms (the z.coerce.boolean trap)", () => {
      expect(DialSettings.parse({ reverseRotation: true }).reverseRotation).toBe(true);
      expect(DialSettings.parse({ reverseRotation: "true" }).reverseRotation).toBe(true);
      expect(DialSettings.parse({ reverseRotation: "false" }).reverseRotation).toBe(false);
    });
  });

  describe("rotation → cycle modes", () => {
    it("cycles the mapped camera / sub-camera / driving target", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d1") as never, dial({ mode: "camera" }), 1, false);
      surface.rotate(dialContext("d1") as never, dial({ mode: "sub-camera" }), 1, false);
      surface.rotate(dialContext("d1") as never, dial({ mode: "driving" }), -1, false);

      expect(host.cycle).toHaveBeenNthCalledWith(1, "cycle-camera", "next");
      expect(host.cycle).toHaveBeenNthCalledWith(2, "cycle-sub-camera", "next");
      expect(host.cycle).toHaveBeenNthCalledWith(3, "cycle-driving", "previous");
    });

    it("dispatches one cycle step per rotate event regardless of tick magnitude", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d2") as never, dial({ mode: "camera" }), 3, false);

      expect(host.cycle).toHaveBeenCalledTimes(1);
    });

    it("reverses the cycle direction when reverseRotation is set (#884)", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d4") as never, dial({ mode: "camera", reverseRotation: true }), 1, false);
      surface.rotate(dialContext("d4") as never, dial({ mode: "driving", reverseRotation: true }), -1, false);

      expect(host.cycle).toHaveBeenNthCalledWith(1, "cycle-camera", "previous");
      expect(host.cycle).toHaveBeenNthCalledWith(2, "cycle-driving", "next");
    });

    it("still dispatches sub-camera / camera cycling when the pace car (unclassified) has focus — keypad parity (#803)", () => {
      // The pace car is focused (CamCarIdx 0, no classified race position). Cycle
      // modes must dispatch under EXACTLY the keypad's conditions — the dial adds
      // no pace-car guard of its own — so `host.cycle` (the keypad's executeCycle)
      // still fires. Whatever the SDK then does with the pace car is shared with
      // the keypad; it is not a dial-side stall.
      const host = makeHost({ getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d3") as never, dial({ mode: "sub-camera" }), 1, false);
      surface.rotate(dialContext("d3") as never, dial({ mode: "camera" }), 1, false);

      expect(host.cycle).toHaveBeenNthCalledWith(1, "cycle-sub-camera", "next");
      expect(host.cycle).toHaveBeenNthCalledWith(2, "cycle-camera", "next");
    });
  });

  describe("rotation → car-number mode", () => {
    it("lowers the car number on a clockwise detent and raises it counter-clockwise (#973)", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c1") as never, dial({ mode: "car-number" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3); // focused = #42, clockwise → #3

      surface.rotate(dialContext("c1") as never, dial({ mode: "car-number" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenLastCalledWith(99); // counter-clockwise → #99
    });

    it("raises the car number on a clockwise detent when reverseRotation is set (#973)", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c1b") as never, dial({ mode: "car-number", reverseRotation: true }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(99); // focused = #42, reversed clockwise → #99
    });

    it("does not cycle in car-number mode", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c2") as never, dial({ mode: "car-number" }), 1, false);

      expect(host.cycle).not.toHaveBeenCalled();
    });

    it("skips a car that left the world (post-race) on a counter-clockwise detent (#885)", () => {
      // Cars by number: #3 (carIdx1), #42 (carIdx3, focused), #99 (carIdx5).
      // carIdx5 despawned (TrackSurface NotInWorld) with stale-but-valid lap
      // telemetry — the surface signal alone must mark it absent. Counter-
      // clockwise walks UP the number order since #973, so it wraps past #99
      // to #3 instead of dead-switching.
      const host = makeHost({
        getTelemetry: vi.fn(
          () =>
            ({
              CamCarIdx: 3,
              CarIdxLapCompleted: [-1, 10, -1, 10, -1, 10],
              CarIdxLapDistPct: [-1, 0.2, -1, 0.4, -1, 0.6],
              CarIdxTrackSurface: [-1, 3, -1, 3, -1, -1],
            }) as never,
        ),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c885") as never, dial({ mode: "car-number" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3);
    });

    it("skips a car that left the world (post-race) on a clockwise detent (#885)", () => {
      // Mirror of the case above for the default direction: carIdx1 (#3) is the
      // despawned one, so a clockwise detent — which walks DOWN the number order
      // since #973 — wraps past #3 to #99.
      const host = makeHost({
        getTelemetry: vi.fn(
          () =>
            ({
              CamCarIdx: 3,
              CarIdxLapCompleted: [-1, 10, -1, 10, -1, 10],
              CarIdxLapDistPct: [-1, 0.2, -1, 0.4, -1, 0.6],
              CarIdxTrackSurface: [-1, -1, -1, 3, -1, 3],
            }) as never,
        ),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c885b") as never, dial({ mode: "car-number" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(99);
    });

    it("recovers to an end of the field when the pace car (not in the number list) has focus (#803)", () => {
      // getAllCarNumbers(…, true, true) EXCLUDES the pace car, so the focused
      // pace-car index isn't in the list — car-number mode already re-enters at
      // the first (next) / last (previous) car rather than stalling.
      const host = makeHost({ getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c3") as never, dial({ mode: "car-number" }), 1, false);

      // Clockwise walks DOWN the number order since #973, so it re-enters at the end.
      expect(host.focusCarNumber).toHaveBeenCalledWith(99); // last car by number (#99)

      surface.rotate(dialContext("c3") as never, dial({ mode: "car-number" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenLastCalledWith(3); // first car by number (#3)
    });
  });

  describe("rotation → track-order mode (#886)", () => {
    // Field layout: see the module-level ON_TRACK fixture.

    it("focuses the car physically AHEAD on a clockwise detent and the car BEHIND counter-clockwise", () => {
      const host = makeHost({ getTelemetry: vi.fn(() => ON_TRACK as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t1") as never, dial({ mode: "track-order" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3); // ahead of #42 on the road is #3

      surface.rotate(dialContext("t1") as never, dial({ mode: "track-order" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenLastCalledWith(99); // behind #42 (wrapping) is #99
    });

    it("focuses the car BEHIND on a clockwise detent when reverseRotation is set", () => {
      const host = makeHost({ getTelemetry: vi.fn(() => ON_TRACK as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t2") as never, dial({ mode: "track-order", reverseRotation: true }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(99);
    });

    it("does not cycle in track-order mode", () => {
      const host = makeHost({ getTelemetry: vi.fn(() => ON_TRACK as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t3") as never, dial({ mode: "track-order" }), 1, false);

      expect(host.cycle).not.toHaveBeenCalled();
    });

    it("skips the pace car sitting between two competitors on the road (not a competitor)", async () => {
      // carIdx 0 is the pace car: it is on track at 0.40 (between #42 and #3) but
      // getAllCarNumbers(…, true, true) excludes it, so a detent lands on #3.
      const withPaceCar = {
        ...ON_TRACK,
        CarIdxLapDistPct: [0.4, 0.55, -1, 0.3, -1, 0.8],
        CarIdxTrackSurface: [3, 3, -1, 3, -1, 3],
      };
      const host = makeHost({ getTelemetry: vi.fn(() => withPaceCar as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t4") as never, dial({ mode: "track-order" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3);
      // The competitor set is the pace-car/spectator-EXCLUDING list — the mock
      // ignores the flags, so pin them explicitly: this is what keeps the pace
      // car (absent from mockAllCars) out of the road walk.
      const { getAllCarNumbers } = await import("@iracedeck/iracing-sdk");
      expect(getAllCarNumbers).toHaveBeenLastCalledWith(expect.anything(), true, true);
    });

    it("skips a competitor that left the world and focuses the next one along the road (#885)", () => {
      // #3 (carIdx1) despawned: stale lap distance but a NotInWorld surface.
      const towed = { ...ON_TRACK, CarIdxTrackSurface: [-1, -1, -1, 3, -1, 3] };
      const host = makeHost({ getTelemetry: vi.fn(() => towed as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t5") as never, dial({ mode: "track-order" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(99);
    });

    it("does nothing when no other competitor is on track", () => {
      const alone = { ...ON_TRACK, CarIdxLapDistPct: [-1, -1, -1, 0.3, -1, -1] };
      const host = makeHost({ getTelemetry: vi.fn(() => alone as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t6") as never, dial({ mode: "track-order" }), 1, false);

      expect(host.focusCarNumber).not.toHaveBeenCalled();
    });

    it("does nothing without on-track telemetry", () => {
      const host = makeHost(); // TELEMETRY has no CarIdxLapDistPct
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("t7") as never, dial({ mode: "track-order" }), 1, false);

      expect(host.focusCarNumber).not.toHaveBeenCalled();
    });
  });

  describe("rotation → race-position mode", () => {
    it("focuses the car AHEAD (P# decreases) on a clockwise detent — the #884 default", () => {
      // carIdx→position: idx1=P3, idx2=P1, idx3=P2; focused CamCarIdx=3 (P2).
      // Clockwise now selects the car ahead: P2 → P1 → carIdx2.
      mockCarNumberRawByIdx.value = { 1: 3, 2: 11, 3: 42 };
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r1") as never, dial({ mode: "race-position" }), 1, false);

      // Dispatched via focusCarNumber (switchNum), NOT a position-based call —
      // switchPos would resolve the position against iRacing's OWN official
      // order, which can diverge from the canonical order used here.
      expect(host.focusCarNumber).toHaveBeenCalledWith(11); // carIdx2 (P1)'s raw number

      // Counter-clockwise selects the car behind: P2 → P3 → carIdx1.
      surface.rotate(dialContext("r1") as never, dial({ mode: "race-position" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenLastCalledWith(3); // carIdx1 (P3)'s raw number
    });

    it("restores the pre-#884 mapping (clockwise → P# increases) when reverseRotation is set", () => {
      mockCarNumberRawByIdx.value = { 1: 3, 2: 11, 3: 42 };
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r1b") as never, dial({ mode: "race-position", reverseRotation: true }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3); // clockwise → P3 (the car behind) again
    });

    it("focuses the CANONICAL car even when the official CarIdxPosition order disagrees (the preview↔execution seam)", () => {
      // Canonical order (getRacePositions): idx1=P3, idx2=P1, idx3=P2 —
      // focused CamCarIdx=3 (P2), so the clockwise target P1 is carIdx2.
      const canonicalOrder = [0, 3, 1, 2];
      // Official CarIdxPosition DIVERGES (e.g. a tow/finish/freeze case per
      // race-positions.md): here idx1=P1, idx2=P2, idx3=P3 — so if execution
      // resolved the target position against the OFFICIAL order instead, P1
      // would be carIdx1, not carIdx2.
      const officialOrder = [0, 1, 2, 3];
      mockCarNumberRawByIdx.value = { 2: 11, 1: 3 }; // carIdx2 → #11 (canonical), carIdx1 → #3 (official-wrong)
      const host = makeHost({
        getRacePositions: vi.fn(() => canonicalOrder),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3, CarIdxPosition: officialOrder }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r-diverge") as never, dial({ mode: "race-position" }), 1, false);

      // Must land on the CANONICAL car (#11 / carIdx2) — the same car the
      // carousel preview shows — never the official-order car (#3 / carIdx1).
      expect(host.focusCarNumber).toHaveBeenCalledWith(11);
      expect(host.focusCarNumber).not.toHaveBeenCalledWith(3);
    });

    it("falls back to official CarIdxPosition when there is no canonical order, resolving the car the SAME way", () => {
      mockCarNumberRawByIdx.value = { 2: 11, 3: 42 };
      const host = makeHost({
        getRacePositions: vi.fn(() => null),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3, CarIdxPosition: [0, 3, 1, 2] }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r2") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.getRacePositions).toHaveBeenCalled();
      // Same car-number resolution path as the canonical case — the fallback
      // order stays coherent between preview and execution too. Clockwise →
      // the car ahead (P1 → carIdx2).
      expect(host.focusCarNumber).toHaveBeenCalledWith(11);
    });

    it("falls back to official CarIdxPosition when the canonical order ranks nobody (#968)", () => {
      // The canonical order is a DENSE array of zeros whenever no car is scored
      // — it ranks by CarIdxLapCompleted + CarIdxLapDistPct, so a field with no
      // completed laps (or a post-race cooldown where the counts are cleared)
      // yields all zeros. A plain `??` accepts that non-null array and the mode
      // dies with maxPosition = 0. NOTE this fallback does NOT rescue the
      // parade lap: there iRacing's own CarIdxPosition is all zeros too
      // (capture 20260815-203305), so the mode legitimately has nothing to
      // cycle until positions exist at all — tracked separately in #974.
      mockCarNumberRawByIdx.value = { 2: 11, 3: 42 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 0, 0, 0]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3, CarIdxPosition: [0, 3, 1, 2] }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r2") as never, dial({ mode: "race-position" }), 1, false);

      // Clockwise → the car ahead (P2 → P1 → carIdx2).
      expect(host.focusCarNumber).toHaveBeenCalledWith(11);
    });

    it("keeps using the canonical order once ANY car is ranked, never the official one", () => {
      // Guards the fallback above from widening: a partially-populated
      // canonical order (only the ranked cars) is still the authority.
      mockCarNumberRawByIdx.value = { 1: 3, 2: 11, 3: 42 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 0, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3, CarIdxPosition: [0, 1, 3, 2] }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r2") as never, dial({ mode: "race-position" }), 1, false);

      // Canonical P1 is carIdx2 (#11); the official order would say carIdx1 (#3).
      expect(host.focusCarNumber).toHaveBeenCalledWith(11);
      expect(host.focusCarNumber).not.toHaveBeenCalledWith(3);
    });

    it("walks past a car that left the world (post-race tow) instead of dispatching a dead switch (#885)", () => {
      // The reported scenario: post-race replay, still in the session. The
      // canonical order keeps the towed leader (carIdx2, P1) at its frozen
      // rank, but the car is NotInWorld (lc/dp -1) — a clockwise detent from
      // P2 must walk past the dead P1 and wrap to the next PRESENT car (P3,
      // carIdx1) rather than re-targeting the same dead switch forever.
      mockCarNumberRawByIdx.value = { 1: 3, 2: 11, 3: 42 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(
          () =>
            ({
              CamCarIdx: 3,
              CarIdxLapCompleted: [-1, 10, -1, 10],
              CarIdxLapDistPct: [-1, 0.5, -1, 0.4],
              CarIdxTrackSurface: [-1, 3, -1, 3],
            }) as never,
        ),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r885") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3); // P3's car — the P1 car is gone
      expect(host.focusCarNumber).not.toHaveBeenCalledWith(11);
    });

    it("does nothing when every other car has left the world (#885)", () => {
      // Everyone but the focused car despawned — no present target anywhere in
      // the walk, so the detent must not dispatch at all.
      mockCarNumberRawByIdx.value = { 1: 3, 2: 11, 3: 42 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(
          () =>
            ({
              CamCarIdx: 3,
              CarIdxLapCompleted: [-1, -1, -1, 10],
              CarIdxLapDistPct: [-1, -1, -1, 0.4],
              CarIdxTrackSurface: [-1, -1, -1, 3],
            }) as never,
        ),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r885b") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.focusCarNumber).not.toHaveBeenCalled();
    });

    it("does nothing when the focused car has no position", () => {
      const host = makeHost({
        getRacePositions: vi.fn(() => null),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3 }) as never), // no CarIdxPosition either
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r3") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.focusCarNumber).not.toHaveBeenCalled();
    });

    it("does nothing when the resolved position has no raw car number in session info", () => {
      mockCarNumberRawByIdx.value = {}; // carIdx1 unmapped
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r4") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.focusCarNumber).not.toHaveBeenCalled();
    });

    it("recovers to last place on a clockwise detent when the focused car has no position (pace car, #803/#884)", () => {
      // order: carIdx0 = P0 (unclassified — the focused PACE car); carIdx2 = P1
      // (leader), carIdx1 = P3 (last). Clockwise walks UP the field (#884), so
      // from outside the order it re-enters at last place and each further
      // clockwise detent moves toward the leader.
      mockCarNumberRawByIdx.value = { 2: 11, 1: 22 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r5") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(22); // last-place (maxPosition) car's raw number
    });

    it("recovers to the leader (P1) on a counter-clockwise detent when the focused car has no position (pace car, #803/#884)", () => {
      mockCarNumberRawByIdx.value = { 2: 11, 1: 22 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r6") as never, dial({ mode: "race-position" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(11); // leader (P1) car's raw number
    });
  });

  describe("press & touch gestures", () => {
    it("fires the press gesture (focus my car) on a short press", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.down(dialContext("p1") as never, dial({ pressAction: "focus-my-car" }));
      await surface.up("p1");

      expect(host.focusMyCar).toHaveBeenCalled();
    });

    it("fires the new focus-on-leader gesture on a short press", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.down(dialContext("p2") as never, dial({ pressAction: "focus-on-leader" }));
      await surface.up("p2");

      expect(host.focusOnLeader).toHaveBeenCalled();
    });

    it("fires the long-press gesture (focus on incident) past the threshold", async () => {
      vi.useFakeTimers();
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.down(dialContext("p3") as never, dial({ pressAction: "none", longPressAction: "focus-on-incident" }));
      vi.advanceTimersByTime(600);
      await surface.up("p3");

      expect(host.focusOnIncident).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("fires no gesture on a push+turn", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const settings = dial({ mode: "car-number", pressAction: "focus-my-car" });
      surface.down(dialContext("p4") as never, settings);
      surface.rotate(dialContext("p4") as never, settings, 1, true);

      expect(host.focusCarNumber).toHaveBeenCalled(); // the rotation still fired

      await surface.up("p4");

      expect(host.focusMyCar).not.toHaveBeenCalled();
    });

    it("fires the tap gesture (focus on most exciting) on a short touch", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      await surface.touchTap(dialContext("t1") as never, dial({ tapAction: "focus-on-most-exciting" }), false);

      expect(host.focusOnMostExciting).toHaveBeenCalled();
    });

    it("does nothing on touch when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      await surface.touchTap(dialContext("t2") as never, dial({ tapAction: "focus-my-car" }), false);

      expect(host.focusMyCar).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("renders the camera carousel with the current group name and glyphs", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f1");
      await surface.willAppear(ctx as never, dial({ mode: "camera" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">CAMERA<"); // mode-name title
      expect(decoded).toContain(">COCKPIT<"); // current group
      expect(decoded).toContain('data-group="Cockpit"');
      expect(decoded).toContain('data-group="Nose"'); // counter-clockwise (prev) on the left
      expect(decoded).toContain('data-group="Chase"'); // clockwise (next) on the right
    });

    it("swaps the camera-carousel preview sides when reverseRotation is set (#884)", async () => {
      // Null glyphs so the side slots render as NAME texts whose x coordinate
      // pins the side (glyph transforms don't expose the slot x directly).
      const host = makeHost({ getGroupGlyph: vi.fn(() => null) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f1b");
      await surface.willAppear(ctx as never, dial({ mode: "camera", reverseRotation: true }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      // Reversed: clockwise cycles to the PREVIOUS group (Nose), so it previews
      // on the right; the next group (Chase) moves to the left.
      expect(decoded).toMatch(sideText(0.82, "NOSE"));
      expect(decoded).toMatch(sideText(0.18, "CHASE"));
    });

    it("renders the car-number carousel with the mode-name title and the focused #number", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">CAR #<"); // mode-name title
      expect(decoded).toContain(">#42<"); // focused car
      expect(decoded).toMatch(sideText(0.84, "#3")); // clockwise (down the number order, #973) on the right
      expect(decoded).toMatch(sideText(0.16, "#99")); // counter-clockwise (up the number order) on the left
    });

    it("swaps the car-number preview sides when reverseRotation is set (#884)", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2b");
      await surface.willAppear(ctx as never, dial({ mode: "car-number", reverseRotation: true }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      // Reversed: clockwise goes UP the number order again, so #99 previews right.
      expect(decoded).toMatch(sideText(0.84, "#99"));
      expect(decoded).toMatch(sideText(0.16, "#3"));
    });

    it("renders the track-order carousel: the focused #number centred, the car ahead on the clockwise side with AHEAD / BEHIND captions (#886)", async () => {
      // On the road (ON_TRACK): #42 (0.30) → #3 (0.55) → #99 (0.80) → wraps. Ahead of #42 is #3, behind is #99.
      const host = makeHost({ getTelemetry: vi.fn(() => ON_TRACK as never) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2t");
      await surface.willAppear(ctx as never, dial({ mode: "track-order" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">TRACK ORDER<"); // mode-name title
      expect(decoded).toContain(">#42<"); // focused car
      expect(decoded).toMatch(sideText(0.84, "#3")); // clockwise = the car AHEAD on the road → right
      expect(decoded).toMatch(sideText(0.84, "AHEAD"));
      expect(decoded).toMatch(sideText(0.16, "#99")); // counter-clockwise = the car BEHIND → left
      expect(decoded).toMatch(sideText(0.16, "BEHIND"));
    });

    it("swaps the track-order preview sides AND captions when reverseRotation is set (#886)", async () => {
      const host = makeHost({ getTelemetry: vi.fn(() => ON_TRACK as never) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2u");
      await surface.willAppear(ctx as never, dial({ mode: "track-order", reverseRotation: true }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      // Clockwise now goes to the car BEHIND, so it (and its caption) previews right.
      expect(decoded).toMatch(sideText(0.84, "#99"));
      expect(decoded).toMatch(sideText(0.84, "BEHIND"));
      expect(decoded).toMatch(sideText(0.16, "#3"));
      expect(decoded).toMatch(sideText(0.16, "AHEAD"));
    });

    it("re-renders the track-order strip when the car ahead changes on the road (#886)", async () => {
      // A moving field: the car ahead of #42 flips from #3 to #99 between two
      // ticks (with #3 dropping behind), so the strip must redraw — the readout
      // signature has to track the ROAD neighbours, not just the focused car.
      const telemetry = { value: { ...ON_TRACK } as Record<string, unknown> };
      const host = makeHost({ getTelemetry: vi.fn(() => telemetry.value as never) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2v");
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
      await surface.willAppear(ctx as never, dial({ mode: "track-order" }));
      const pushesAfterAppear = ctx.setFeedback.mock.calls.length;

      // #3 falls behind #42, #99 is now the car ahead.
      telemetry.value = { ...telemetry.value, CarIdxLapDistPct: [-1, 0.2, -1, 0.3, -1, 0.5] };
      nowSpy.mockReturnValue(10_500);
      surface.onTelemetry("f2v", telemetry.value as never);
      await Promise.resolve();

      expect(ctx.setFeedback.mock.calls.length).toBe(pushesAfterAppear + 1);
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);
      expect(decoded).toMatch(sideText(0.84, "#99"));
      expect(decoded).toMatch(sideText(0.16, "#3"));
      nowSpy.mockRestore();
    });

    it("shows an identity-only label box out of session (track-order)", async () => {
      const host = makeHost({ getTelemetry: vi.fn(() => null) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f5t");
      await surface.willAppear(ctx as never, dial({ mode: "track-order" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">TRACK ORDER<");
      expect(decoded).not.toMatch(/>#/); // no car number readout without a focused car
    });

    it("drops the AHEAD / BEHIND captions when both detents land on the same car (focused car has no track position, #886)", async () => {
      // The focused #42 (carIdx 3) has towed: still in session info (so the centre
      // reads #42) but no lap distance / NotInWorld. The primitive then re-enters
      // at the car nearest start/finish for BOTH directions — #99 at 0.80 (0.20
      // from the line) beats #3 at 0.55 — so both sides preview #99, and one car
      // can't be captioned both AHEAD and BEHIND.
      const towedFocus = {
        ...ON_TRACK,
        CarIdxLapDistPct: [-1, 0.55, -1, -1, -1, 0.8],
        CarIdxTrackSurface: [-1, 3, -1, -1, -1, 3],
      };
      const host = makeHost({ getTelemetry: vi.fn(() => towedFocus as never) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2w");
      await surface.willAppear(ctx as never, dial({ mode: "track-order" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">#42<");
      expect(decoded).toMatch(sideText(0.16, "#99"));
      expect(decoded).toMatch(sideText(0.84, "#99"));
      expect(decoded).not.toMatch(/AHEAD|BEHIND/);
      // …and both detents really do focus that same car.
      surface.rotate(ctx as never, dial({ mode: "track-order" }), 1, false);
      surface.rotate(ctx as never, dial({ mode: "track-order" }), -1, false);
      expect(host.focusCarNumber.mock.calls).toEqual([[99], [99]]);
    });

    it("renders the race-position carousel with the mode-name title, position primary, and car number secondary", async () => {
      mockCarNumberByIdx.value = { 1: "77", 2: "88", 3: "42" };
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f3");
      await surface.willAppear(ctx as never, dial({ mode: "race-position" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">POSITION<"); // mode-name title
      expect(decoded).toContain(">P2<"); // primary: focused car is P2
      expect(decoded).toContain(">#42<"); // secondary: focused car's number, beneath the position
      // Clockwise selects the car ahead (#884), so P1 previews on the RIGHT and
      // the car behind (P3) on the LEFT — the sides follow the effective mapping.
      expect(decoded).toMatch(sideText(0.84, "P1"));
      expect(decoded).toMatch(sideText(0.16, "P3"));
    });

    it("swaps the race-position preview sides when reverseRotation restores the pre-#884 mapping", async () => {
      mockCarNumberByIdx.value = { 1: "77", 2: "88", 3: "42" };
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f3r");
      await surface.willAppear(ctx as never, dial({ mode: "race-position", reverseRotation: true }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      // Reversed: clockwise → P# increases again, so P3 previews on the RIGHT.
      expect(decoded).toMatch(sideText(0.84, "P3"));
      expect(decoded).toMatch(sideText(0.16, "P1"));
    });

    it("previews the recovery-target POSITIONS at the sides, falling back to a number-only centre, when the pace car has focus (#803)", async () => {
      // Focused pace car = carIdx0 (P0, unclassified). Recovery (#884 mapping):
      // clockwise walks up the field, so it re-enters at last place (P3,
      // maxPosition=3) = carIdx1; counter-clockwise → the leader (P1) = carIdx2.
      // The centre has no classified position so it falls back to the plain
      // car number rather than a lying "P0" badge; the side previews still
      // show the real recovery targets the detents will actually focus.
      mockCarNumberByIdx.value = { 0: "0", 2: "1", 1: "99" };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f3b");
      await surface.willAppear(ctx as never, dial({ mode: "race-position" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">#0<"); // number-only centre for the unclassified pace car
      expect(decoded).toMatch(sideText(0.84, "P3")); // clockwise detent → last place
      expect(decoded).toMatch(sideText(0.16, "P1")); // counter-clockwise detent → leader
    });

    it("previews the SKIPPED-TO positions when the immediate neighbours left the world (#885)", async () => {
      // Five cars: carIdx0=P5, carIdx1=P4, carIdx2=P3, carIdx3=P2 (focused),
      // carIdx4=P1. The immediate neighbours both despawned post-race —
      // carIdx4 (P1) and carIdx2 (P3) — so the detents actually land on P5
      // (clockwise, walking up past dead P1) and P4 (counter-clockwise,
      // walking down past dead P3). The side badges must preview THOSE
      // targets, keeping preview == execution.
      mockCarNumberByIdx.value = { 0: "50", 1: "40", 2: "30", 3: "42", 4: "10" };
      const host = makeHost({
        getRacePositions: vi.fn(() => [5, 4, 3, 2, 1]),
        getTelemetry: vi.fn(
          () =>
            ({
              CamCarIdx: 3,
              CamGroupNumber: 9,
              CarIdxLapCompleted: [10, 10, -1, 10, -1],
              CarIdxLapDistPct: [0.1, 0.2, -1, 0.4, -1],
              CarIdxTrackSurface: [3, 3, -1, 3, -1],
            }) as never,
        ),
      });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f885");
      await surface.willAppear(ctx as never, dial({ mode: "race-position" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toMatch(sideText(0.84, "P5")); // clockwise walks past dead P1 to P5
      expect(decoded).toMatch(sideText(0.16, "P4")); // counter-clockwise walks past dead P3 to P4
    });

    // #852: Sub-Camera is the one binding-driven dial mode (iRacing exposes
    // sub-camera stepping only as a key binding), so its strip carries the
    // standard #612 missing-binding warning; the other modes are SDK commands
    // and must never show one.
    it("warns on the sub-camera strip when the sub-camera bindings are unset (#852)", async () => {
      const host = makeHost({ isBindingMissing: vi.fn(() => true) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("d-warn");
      await surface.willAppear(ctx as never, dial({ mode: "sub-camera" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);
      expect(decoded).toContain("binding-warning");
      // Both rotation directions tap a binding, so either missing must warn.
      expect(host.isBindingMissing).toHaveBeenCalledWith(SUB_CAMERA_BINDING_KEY_LIST);
      // The glyph is authored for the 144×144 key canvas — the strip canvas
      // MUST be passed, or the triangle renders off-centre and clipped (#775).
      expect(vi.mocked(applyBindingWarning)).toHaveBeenLastCalledWith(expect.any(String), {
        width: 200,
        height: 100,
      });
    });

    it("never warns on the SDK-driven modes even when bindings are unset", async () => {
      const host = makeHost({ isBindingMissing: vi.fn(() => true) });
      const surface = new CameraDialSurface(host as never);

      for (const mode of ["camera", "car-number", "race-position", "driving"] as const) {
        const ctx = dialContext(`d-nowarn-${mode}`);
        await surface.willAppear(ctx as never, dial({ mode }));
        const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);
        expect(decoded).not.toContain("binding-warning");
      }
    });

    it("renders the sub-camera name carousel from the group's camera list", async () => {
      // The focused camera (CamCameraNumber 2) and its neighbours come straight
      // from getCamerasInGroup — the SAME list computeSubCameraCarousel steps
      // through for the dispatch, so preview == execution.
      mockCameras.value = [
        { cameraNum: 1, cameraName: "Cockpit" },
        { cameraNum: 2, cameraName: "Roll Bar" },
        { cameraNum: 3, cameraName: "Gyro" },
      ];
      const host = makeHost({
        getTelemetry: vi.fn(() => ({ CamGroupNumber: 9, CamCarIdx: 3, CamCameraNumber: 2 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f4");
      await surface.willAppear(ctx as never, dial({ mode: "sub-camera" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">SUB-CAMERA<"); // mode-name title
      expect(decoded).toContain(">ROLL BAR<"); // current camera (cameraNum 2)
      expect(decoded).toMatch(sideText(0.15, "COCKPIT")); // counter-clockwise (prev, cameraNum 1) on the left
      expect(decoded).toMatch(sideText(0.85, "GYRO")); // clockwise (next, cameraNum 3) on the right
      // The focused CAR number is no longer part of the sub-camera strip.
      expect(decoded).not.toContain(">#42<");
    });

    it("swaps the sub-camera preview sides when reverseRotation is set (#884)", async () => {
      mockCameras.value = [
        { cameraNum: 1, cameraName: "Cockpit" },
        { cameraNum: 2, cameraName: "Roll Bar" },
        { cameraNum: 3, cameraName: "Gyro" },
      ];
      const host = makeHost({
        getTelemetry: vi.fn(() => ({ CamGroupNumber: 9, CamCarIdx: 3, CamCameraNumber: 2 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f4r");
      await surface.willAppear(ctx as never, dial({ mode: "sub-camera", reverseRotation: true }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toMatch(sideText(0.85, "COCKPIT")); // clockwise now steps to the previous camera
      expect(decoded).toMatch(sideText(0.15, "GYRO"));
    });

    it("wraps the sub-camera carousel at the ends of the group's camera list", async () => {
      // Focused on the LAST camera (cameraNum 3) — next wraps to cameraNum 1.
      mockCameras.value = [
        { cameraNum: 1, cameraName: "Cockpit" },
        { cameraNum: 2, cameraName: "Roll Bar" },
        { cameraNum: 3, cameraName: "Gyro" },
      ];
      const host = makeHost({
        getTelemetry: vi.fn(() => ({ CamGroupNumber: 9, CamCarIdx: 3, CamCameraNumber: 3 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f4b");
      await surface.willAppear(ctx as never, dial({ mode: "sub-camera" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">GYRO<"); // current (cameraNum 3)
      expect(decoded).toContain(">ROLL BAR<"); // prev (cameraNum 2)
      expect(decoded).toContain(">COCKPIT<"); // next wraps to cameraNum 1
    });

    it("renders the driving strip as the current camera group only (no invented preview)", async () => {
      // Driving hands `group ± 1` to iRacing, which resolves + wraps it
      // internally, so there is NO coherent neighbour to preview — current only.
      const host = makeHost({ getTelemetry: vi.fn(() => ({ CamGroupNumber: 9, CamCarIdx: 3 }) as never) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f4c");
      await surface.willAppear(ctx as never, dial({ mode: "driving" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">DRIVING CAM<"); // mode-name title
      expect(decoded).toContain(">COCKPIT<"); // current group (group 9)
      expect(decoded).toContain('data-group="Cockpit"'); // current group glyph
      // No neighbour groups previewed.
      expect(decoded).not.toContain('data-group="Nose"');
      expect(decoded).not.toContain('data-group="Chase"');
    });

    it("shows an identity-only label box out of session (car-number)", async () => {
      const host = makeHost({ getTelemetry: vi.fn(() => null) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f5");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">CAR #<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f6");
      await surface.willAppear(
        ctx as never,
        dial({ mode: "car-number", colors: { borderColor: "#112233", backgroundColor: "#445566" } }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes the encoder trigger description and the two-line name icon", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f7");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">CAMERA<");
      expect(img).toContain(">CONTROLS<");
    });

    it("throttles feedback to the change-render window so the setFeedback cap holds", async () => {
      vi.useFakeTimers();
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f8");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));
      ctx.setFeedback.mockClear();

      vi.advanceTimersByTime(50);
      mockCarNumber.value = "7"; // focused car number (getCarNumberFromSessionInfo)
      surface.onTelemetry("f8", TELEMETRY as never);

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      mockCarNumber.value = "9";
      surface.onTelemetry("f8", TELEMETRY as never);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">#9<");
      vi.useRealTimers();
    });

    it("records the RENDERED state as the change-detector baseline, not state that arrived mid-push", async () => {
      vi.useFakeTimers();
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f8b");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));
      ctx.setFeedback.mockClear();

      // Defer the next push so telemetry can advance while it is in flight.
      let resolvePush: () => void = () => {};
      ctx.setFeedback.mockImplementationOnce(() => new Promise<void>((resolve) => (resolvePush = resolve)));

      vi.advanceTimersByTime(200);
      mockCarNumber.value = "7";
      surface.onTelemetry("f8b", TELEMETRY as never); // renders #7; push pending

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      // Telemetry advances to #9 WHILE the #7 push is still in flight — the
      // baseline must stay at the rendered #7, or #9's render is suppressed.
      mockCarNumber.value = "9";
      resolvePush();
      await Promise.resolve();
      await Promise.resolve();

      vi.advanceTimersByTime(200);
      surface.onTelemetry("f8b", TELEMETRY as never);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">#9<");
      vi.useRealTimers();
    });

    it("re-renders the box and trigger description when the settings change", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f9");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));
      ctx.setFeedback.mockClear();
      ctx.setTriggerDescription.mockClear();

      await surface.didReceiveSettings(ctx as never, dial({ mode: "camera" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      expect(ctx.setFeedback).toHaveBeenCalled();
    });

    it("does not push feedback when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f10");
      await surface.willAppear(ctx as never, dial({ mode: "camera" }));

      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });

    it("re-renders every context on refreshAll (subset / appearance edits offline)", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f11");
      await surface.willAppear(ctx as never, dial({ mode: "camera" }));
      ctx.setFeedback.mockClear();

      surface.refreshAll();

      expect(ctx.setFeedback).toHaveBeenCalled();
    });

    it("computes the carousel preview from the same enabled subset the rotation honors", async () => {
      const getEnabledCameraGroups = vi.fn(() => ["Nose", "Chase"]); // Cockpit excluded
      const host = makeHost({ getEnabledCameraGroups });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f12");
      await surface.willAppear(ctx as never, dial({ mode: "camera" }));

      expect(getEnabledCameraGroups).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      // Current (Cockpit, group 9) still renders even though it is not enabled;
      // the neighbours come from the enabled subset (Nose < 9 < Chase).
      expect(decoded).toContain(">COCKPIT<");
      expect(decoded).toContain('data-group="Nose"');
      expect(decoded).toContain('data-group="Chase"');
    });
  });

  describe("context lifecycle", () => {
    it("drops the context on willDisappear so a later release is a no-op", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("l1");
      await surface.willAppear(ctx as never, dial({ pressAction: "focus-my-car" }));

      surface.down(ctx as never, dial({ pressAction: "focus-my-car" }));
      surface.willDisappear("l1");
      await surface.up("l1");

      expect(host.focusMyCar).not.toHaveBeenCalled();
    });
  });
});
