import { beforeEach, describe, expect, it, vi } from "vitest";

import { SUB_CAMERA_BINDING_KEYS } from "../actions/camera-controls/sub-camera-bindings.js";
import { CAR_CYCLE_BINDING_KEYS } from "./car-cycle-bindings.js";
import { noteCameraKeyTap } from "./car-cycle-focus.js";

const { noteCarKeyTapped } = vi.hoisted(() => ({ noteCarKeyTapped: vi.fn() }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: () => ({ camera: { noteCarKeyTapped } }),
}));

describe("noteCameraKeyTap (#1656)", () => {
  beforeEach(() => {
    noteCarKeyTapped.mockClear();
  });

  it.each([
    ["Next Car", CAR_CYCLE_BINDING_KEYS.next],
    ["Previous Car", CAR_CYCLE_BINDING_KEYS.previous],
  ])("forgets the director focus for a %s tap", (_name, key) => {
    noteCameraKeyTap(key);

    expect(noteCarKeyTapped).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Next Sub Camera, which keeps the car", SUB_CAMERA_BINDING_KEYS.next],
    ["Previous Sub Camera, which keeps the car", SUB_CAMERA_BINDING_KEYS.previous],
    ["an unrelated key", "blackBoxLapTiming"],
    ["an empty key", ""],
  ])("leaves it for %s", (_name, key) => {
    noteCameraKeyTap(key);

    expect(noteCarKeyTapped).not.toHaveBeenCalled();
  });
});
