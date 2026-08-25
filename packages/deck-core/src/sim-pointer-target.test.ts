import { describe, expect, it } from "vitest";

import { DEFAULT_POINTER_X_FRACTION, DEFAULT_POINTER_Y_FRACTION } from "./mouse-pointer-service.js";
import {
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  POINTER_OFFSET_LIMIT,
  resolveSimPointerTarget,
  type SimPointerTargetConfig,
} from "./sim-pointer-target.js";

const config = (overrides: Partial<SimPointerTargetConfig> = {}): SimPointerTargetConfig => ({
  anchorX: DEFAULT_POINTER_ANCHOR_X,
  anchorY: DEFAULT_POINTER_ANCHOR_Y,
  offsetX: DEFAULT_POINTER_OFFSET_X,
  offsetY: DEFAULT_POINTER_OFFSET_Y,
  ...overrides,
});

describe("resolveSimPointerTarget", () => {
  it("resolves the shipped defaults to the pre-#1029 placement", () => {
    expect(resolveSimPointerTarget(config())).toEqual({
      xFraction: DEFAULT_POINTER_X_FRACTION,
      yFraction: DEFAULT_POINTER_Y_FRACTION,
    });
  });

  it.each([
    ["left", 0],
    ["center", 0.5],
    ["right", 1],
  ] as const)("maps the %s anchor to %s with no offset", (anchorX, xFraction) => {
    expect(resolveSimPointerTarget(config({ anchorX, offsetX: 0 })).xFraction).toBe(xFraction);
  });

  it.each([
    ["top", 0],
    ["middle", 0.5],
    ["bottom", 1],
  ] as const)("maps the %s anchor to %s with no offset", (anchorY, yFraction) => {
    expect(resolveSimPointerTarget(config({ anchorY, offsetY: 0 })).yFraction).toBe(yFraction);
  });

  it("shifts by the offset as a percentage of the client area", () => {
    const target = resolveSimPointerTarget(config({ anchorX: "center", offsetX: 25, anchorY: "middle", offsetY: -10 }));

    expect(target).toEqual({ xFraction: 0.75, yFraction: 0.4 });
  });

  it("clamps a target pushed past either edge back into the client area", () => {
    expect(resolveSimPointerTarget(config({ anchorX: "right", offsetX: 50, anchorY: "top", offsetY: -50 }))).toEqual({
      xFraction: 1,
      yFraction: 0,
    });
  });

  it("falls back to the default anchor when a persisted value is not a known anchor", () => {
    const broken = config({ anchorX: "sideways" as never, anchorY: "diagonal" as never, offsetX: 0, offsetY: 0 });

    expect(resolveSimPointerTarget(broken)).toEqual({ xFraction: 0.5, yFraction: 0 });
  });

  it("falls back to the default anchor for a key inherited from Object.prototype", () => {
    // A plain lookup returns `Object.prototype.constructor` here — not `undefined`,
    // so `??` would never fire, and the sum would go NaN and land the pointer
    // top-left rather than on the default.
    const broken = config({ anchorX: "constructor" as never, anchorY: "toString" as never, offsetX: 0, offsetY: 0 });

    expect(resolveSimPointerTarget(broken)).toEqual({ xFraction: 0.5, yFraction: 0 });
  });

  it("treats a non-finite offset as no offset", () => {
    const broken = config({
      anchorX: "center",
      offsetX: Number.NaN,
      anchorY: "middle",
      offsetY: Number.POSITIVE_INFINITY,
    });

    expect(resolveSimPointerTarget(broken)).toEqual({ xFraction: 0.5, yFraction: 0.5 });
  });

  it("limits an offset to the span between two neighbouring anchors", () => {
    expect(POINTER_OFFSET_LIMIT).toBe(50);
  });
});
