import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  CameraDialSurface,
  computeCarNumberTarget,
  computeRacePositionTarget,
  DialSettings,
  renderCameraCarousel,
  renderCarCarousel,
  renderSubCameraCarousel,
  wrapPosition,
} from "./camera-dial-surface.js";

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
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
  escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  svgToDataUri: (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`,
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  getCameraGroupsFromSessionInfo: vi.fn(() => mockGroups.value),
  getCamerasInGroup: vi.fn(() => mockCameras.value),
  getCarNumberFromSessionInfo: vi.fn((_s: unknown, carIdx: number) =>
    mockCarNumberByIdx.value ? (mockCarNumberByIdx.value[carIdx] ?? null) : mockCarNumber.value,
  ),
  getCarNumberRawFromSessionInfo: vi.fn((_s: unknown, carIdx: number) =>
    mockCarNumberRawByIdx.value ? (mockCarNumberRawByIdx.value[carIdx] ?? null) : null,
  ),
  getAllCarNumbers: vi.fn(() => mockAllCars.value),
}));

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

function makeHost(over: Partial<Record<string, unknown>> = {}) {
  return {
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getTelemetry: vi.fn(() => TELEMETRY as never),
    getSessionInfo: vi.fn(() => ({}) as unknown),
    getRacePositions: vi.fn(() => null as number[] | null),
    getEnabledCameraGroups: vi.fn(() => ["Nose", "Cockpit", "Chase"]),
    getGroupGlyph: vi.fn((name: string) => ({ width: 68, height: 68, artwork: `<path data-group="${name}"/>` })),
    cycle: vi.fn(),
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
        prev: { name: "Nose", glyph: { width: 68, height: 68, artwork: '<path data-g="Nose"/>' } },
        next: { name: "Chase", glyph: { width: 68, height: 68, artwork: '<path data-g="Chase"/>' } },
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
        prev: { name: "Scenic", glyph: null },
        next: null,
      });

      expect(svg).toContain(">SCENIC<");
      expect(svg).toContain(">COCKPIT<");
    });

    it("renders current only (no side glyphs) when prev/next are null — the driving mode shape", () => {
      const svg = renderCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "DRIVING CAM",
        identityLabel: "DRIVING",
        current: { name: "Cockpit", glyph: { width: 68, height: 68, artwork: '<path data-g="Cockpit"/>' } },
        prev: null,
        next: null,
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
        prev: null,
        next: null,
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
        prev: "Cockpit",
        next: "Gyro",
      });

      expect(svg).toContain(">SUB-CAMERA<"); // mode-name title
      expect(svg).toContain(">ROLL BAR<"); // current camera (uppercased)
      expect(svg).toContain(">COCKPIT<"); // prev camera
      expect(svg).toContain(">GYRO<"); // next camera
    });

    it("falls back to the identity label with no current camera", () => {
      const svg = renderSubCameraCarousel({
        width: 200,
        height: 100,
        colors,
        title: "SUB-CAMERA",
        identityLabel: "SUB CAM",
        current: null,
        prev: null,
        next: null,
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
        prev: "3",
        next: "99",
        position: null,
      });

      expect(svg).toContain(">CAR #<"); // mode-name title
      expect(svg).toContain(">#42<");
      expect(svg).toContain(">#3<");
      expect(svg).toContain(">#99<");
      expect(svg).not.toMatch(/>P\d/); // no position badge (title "CAR #" is not a badge)
    });

    it("adds the position badge in race-position mode", () => {
      const svg = renderCarCarousel({
        width: 200,
        height: 100,
        colors,
        title: "POSITION",
        identityLabel: "POSITION",
        center: "42",
        prev: "7",
        next: "5",
        position: 4,
      });

      expect(svg).toContain(">POSITION<"); // mode-name title
      expect(svg).toContain(">P4<");
      expect(svg).toContain(">#42<");
    });

    it("falls back to the identity label with no focused car", () => {
      const svg = renderCarCarousel({
        width: 200,
        height: 100,
        colors,
        title: "CAR #",
        identityLabel: "CAR #",
        center: null,
        prev: null,
        next: null,
        position: null,
      });

      expect(svg).toContain(">CAR #<");
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

    it("defaults to car-number for a fresh dial", () => {
      expect(DialSettings.parse({}).mode).toBe("car-number");
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
    it("focuses the next / previous car by ascending number", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c1") as never, dial({ mode: "car-number" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(99); // focused = #42, next = #99

      surface.rotate(dialContext("c1") as never, dial({ mode: "car-number" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenLastCalledWith(3); // previous = #3
    });

    it("does not cycle in car-number mode", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c2") as never, dial({ mode: "car-number" }), 1, false);

      expect(host.cycle).not.toHaveBeenCalled();
    });

    it("recovers to an end of the field when the pace car (not in the number list) has focus (#803)", () => {
      // getAllCarNumbers(…, true, true) EXCLUDES the pace car, so the focused
      // pace-car index isn't in the list — car-number mode already re-enters at
      // the first (next) / last (previous) car rather than stalling.
      const host = makeHost({ getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("c3") as never, dial({ mode: "car-number" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(3); // first car by number (#3)

      surface.rotate(dialContext("c3") as never, dial({ mode: "car-number" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenLastCalledWith(99); // last car by number (#99)
    });
  });

  describe("rotation → race-position mode", () => {
    it("focuses the target car BY NUMBER, resolved from the canonical live order (not a bare position)", () => {
      // carIdx→position: idx1=P3, idx2=P1, idx3=P2; focused CamCarIdx=3 (P2), next → P3 → carIdx1.
      mockCarNumberRawByIdx.value = { 1: 3, 3: 42 };
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r1") as never, dial({ mode: "race-position" }), 1, false);

      // Dispatched via focusCarNumber (switchNum), NOT a position-based call —
      // switchPos would resolve the position against iRacing's OWN official
      // order, which can diverge from the canonical order used here.
      expect(host.focusCarNumber).toHaveBeenCalledWith(3); // carIdx1's raw number
    });

    it("focuses the CANONICAL car even when the official CarIdxPosition order disagrees (the preview↔execution seam)", () => {
      // Canonical order (getRacePositions): idx1=P3, idx2=P1, idx3=P2 — same as
      // above, so P3 (the rotation target) is carIdx1.
      const canonicalOrder = [0, 3, 1, 2];
      // Official CarIdxPosition DIVERGES (e.g. a tow/finish/freeze case per
      // race-positions.md): here idx1=P1, idx2=P2, idx3=P3 — so if execution
      // resolved the target position against the OFFICIAL order instead, P3
      // would be carIdx3, not carIdx1.
      const officialOrder = [0, 1, 2, 3];
      mockCarNumberRawByIdx.value = { 1: 3, 3: 42 }; // carIdx1 → #3 (canonical), carIdx3 → #42 (official-wrong)
      const host = makeHost({
        getRacePositions: vi.fn(() => canonicalOrder),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3, CarIdxPosition: officialOrder }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r-diverge") as never, dial({ mode: "race-position" }), 1, false);

      // Must land on the CANONICAL car (#3 / carIdx1) — the same car the
      // carousel preview shows — never the official-order car (#42 / carIdx3).
      expect(host.focusCarNumber).toHaveBeenCalledWith(3);
      expect(host.focusCarNumber).not.toHaveBeenCalledWith(42);
    });

    it("falls back to official CarIdxPosition when there is no canonical order, resolving the car the SAME way", () => {
      mockCarNumberRawByIdx.value = { 1: 3, 3: 42 };
      const host = makeHost({
        getRacePositions: vi.fn(() => null),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 3, CarIdxPosition: [0, 3, 1, 2] }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r2") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.getRacePositions).toHaveBeenCalled();
      // Same car-number resolution path as the canonical case — the fallback
      // order stays coherent between preview and execution too.
      expect(host.focusCarNumber).toHaveBeenCalledWith(3);
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

    it("recovers to the leader (P1) on a next detent when the focused car has no position (pace car, #803)", () => {
      // order: carIdx0 = P0 (unclassified — the focused PACE car); carIdx2 = P1
      // (leader), carIdx1 = P3 (last). raw numbers: leader carIdx2 → 11.
      mockCarNumberRawByIdx.value = { 2: 11, 1: 22 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r5") as never, dial({ mode: "race-position" }), 1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(11); // leader (P1) car's raw number
    });

    it("recovers to last place on a previous detent when the focused car has no position (pace car, #803)", () => {
      mockCarNumberRawByIdx.value = { 2: 11, 1: 22 };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("r6") as never, dial({ mode: "race-position" }), -1, false);

      expect(host.focusCarNumber).toHaveBeenCalledWith(22); // last-place (maxPosition) car's raw number
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
      expect(decoded).toContain('data-group="Nose"'); // prev
      expect(decoded).toContain('data-group="Chase"'); // next
    });

    it("renders the car-number carousel with the mode-name title and the focused #number", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2");
      await surface.willAppear(ctx as never, dial({ mode: "car-number" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">CAR #<"); // mode-name title
      expect(decoded).toContain(">#42<"); // focused car
      expect(decoded).toContain(">#99<"); // next by number
      expect(decoded).toContain(">#3<"); // previous by number
    });

    it("renders the race-position carousel with the mode-name title and a position badge", async () => {
      mockCarNumberByIdx.value = { 1: "77", 2: "88", 3: "42" };
      const host = makeHost({ getRacePositions: vi.fn(() => [0, 3, 1, 2]) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f3");
      await surface.willAppear(ctx as never, dial({ mode: "race-position" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">POSITION<"); // mode-name title
      expect(decoded).toContain(">P2<"); // focused car is P2
      expect(decoded).toContain(">#42<"); // focused car number
    });

    it("previews the recovery targets (leader / last) with no position badge when the pace car has focus (#803)", async () => {
      // Focused pace car = carIdx0 (P0, unclassified). Leader (P1) = carIdx2,
      // last (P3) = carIdx1. Preview must show the recovery neighbours the
      // detents will actually focus, and NO Pn badge for the unclassified car.
      mockCarNumberByIdx.value = { 0: "0", 2: "1", 1: "99" };
      const host = makeHost({
        getRacePositions: vi.fn(() => [0, 3, 1, 2]),
        getTelemetry: vi.fn(() => ({ CamCarIdx: 0, CamGroupNumber: 9 }) as never),
      });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f3b");
      await surface.willAppear(ctx as never, dial({ mode: "race-position" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">#0<"); // focused pace car
      expect(decoded).toContain(">#1<"); // next detent → leader (P1)
      expect(decoded).toContain(">#99<"); // previous detent → last place
      // No position badge (P<digit>) for the unclassified car — the "POSITION"
      // title starts with P but is never followed by a digit.
      expect(decoded).not.toMatch(/>P\d/);
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
      expect(decoded).toContain(">COCKPIT<"); // prev camera (cameraNum 1)
      expect(decoded).toContain(">GYRO<"); // next camera (cameraNum 3)
      // The focused CAR number is no longer part of the sub-camera strip.
      expect(decoded).not.toContain(">#42<");
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
