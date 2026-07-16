import { beforeEach, describe, expect, it, vi } from "vitest";

import { migrateLfeIntensityBindingKeys, migrateLfeIntensityModes } from "./migrate-lfe-intensity.js";

const { mockDeleteGlobalSettings, mockGetGlobalSettings, mockUpdateGlobalSettings } = vi.hoisted(() => ({
  mockDeleteGlobalSettings: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
  mockUpdateGlobalSettings: vi.fn(),
}));

vi.mock("@iracedeck/deck-core", () => ({
  deleteGlobalSettings: mockDeleteGlobalSettings,
  getGlobalSettings: mockGetGlobalSettings,
  updateGlobalSettings: mockUpdateGlobalSettings,
  // Mirrors the real semantics: non-empty JSON string or object parses to a
  // binding, anything unset/empty/malformed is undefined.
  parseBinding: vi.fn((raw: unknown) => {
    if (typeof raw === "string" && raw) {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }

    if (raw && typeof raw === "object") return raw;

    return undefined;
  }),
}));

const KEYBOARD_BINDING = '{"type":"keyboard","key":"f24","modifiers":[]}';
const SIMHUB_BINDING = '{"type":"simhub","role":"Wheel LFE Louder"}';

describe("migrateLfeIntensityModes", () => {
  it("should map wheel-lfe-intensity to wheel-lfe and preserve other settings", () => {
    const { migrated, changed } = migrateLfeIntensityModes({
      mode: "wheel-lfe-intensity",
      direction: "increase",
      flagsOverlay: true,
    });

    expect(changed).toBe(true);
    expect(migrated).toEqual({ mode: "wheel-lfe", direction: "increase", flagsOverlay: true });
  });

  it("should map haptic-lfe-intensity to bass-shaker-lfe", () => {
    const { migrated, changed } = migrateLfeIntensityModes({ mode: "haptic-lfe-intensity", direction: "decrease" });

    expect(changed).toBe(true);
    expect(migrated).toEqual({ mode: "bass-shaker-lfe", direction: "decrease" });
  });

  it("should leave canonical modes unchanged", () => {
    for (const mode of ["auto-compute-ffb-force", "ffb-force", "wheel-lfe", "bass-shaker-lfe"]) {
      const { migrated, changed } = migrateLfeIntensityModes({ mode, direction: "increase" });

      expect(changed).toBe(false);
      expect(migrated).toEqual({ mode, direction: "increase" });
    }
  });

  it("should leave settings without a mode unchanged", () => {
    const { migrated, changed } = migrateLfeIntensityModes({ direction: "decrease" });

    expect(changed).toBe(false);
    expect(migrated).toEqual({ direction: "decrease" });
  });

  it("should return an empty object for non-object input", () => {
    for (const raw of [undefined, null, "wheel-lfe-intensity", 42]) {
      const { migrated, changed } = migrateLfeIntensityModes(raw);

      expect(changed).toBe(false);
      expect(migrated).toEqual({});
    }
  });

  it("should map a retired dial.setting to its canonical value and preserve other dial fields", () => {
    const { migrated, changed } = migrateLfeIntensityModes({
      mode: "wheel-lfe",
      dial: { setting: "haptic-lfe-intensity", pressAction: "auto-ffb", borderColor: "#123456" },
    });

    expect(changed).toBe(true);
    expect(migrated).toEqual({
      mode: "wheel-lfe",
      dial: { setting: "bass-shaker-lfe", pressAction: "auto-ffb", borderColor: "#123456" },
    });
  });

  it("should map a retired keypad mode and a retired dial.setting in one pass", () => {
    const { migrated, changed } = migrateLfeIntensityModes({
      mode: "wheel-lfe-intensity",
      dial: { setting: "wheel-lfe-intensity" },
    });

    expect(changed).toBe(true);
    expect(migrated).toEqual({ mode: "wheel-lfe", dial: { setting: "wheel-lfe" } });
  });

  it("should leave a canonical dial.setting unchanged", () => {
    const { migrated, changed } = migrateLfeIntensityModes({ dial: { setting: "ffb-force" } });

    expect(changed).toBe(false);
    expect(migrated).toEqual({ dial: { setting: "ffb-force" } });
  });
});

describe("migrateLfeIntensityBindingKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({});
  });

  it("should carry a retired binding over to an unset canonical key and drop the retired key", () => {
    mockGetGlobalSettings.mockReturnValue({
      forceFeedbackWheelLfeIntensityIncrease: KEYBOARD_BINDING,
    });

    migrateLfeIntensityBindingKeys();

    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ forceFeedbackWheelLfeLouder: KEYBOARD_BINDING });
    expect(mockDeleteGlobalSettings).toHaveBeenCalledWith(["forceFeedbackWheelLfeIntensityIncrease"]);
  });

  it("should carry over all four retired keys to their canonical counterparts", () => {
    mockGetGlobalSettings.mockReturnValue({
      forceFeedbackWheelLfeIntensityIncrease: KEYBOARD_BINDING,
      forceFeedbackWheelLfeIntensityDecrease: KEYBOARD_BINDING,
      forceFeedbackHapticLfeIntensityIncrease: SIMHUB_BINDING,
      forceFeedbackHapticLfeIntensityDecrease: SIMHUB_BINDING,
    });

    migrateLfeIntensityBindingKeys();

    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
      forceFeedbackWheelLfeLouder: KEYBOARD_BINDING,
      forceFeedbackWheelLfeQuieter: KEYBOARD_BINDING,
      forceFeedbackBassShakerLfeLouder: SIMHUB_BINDING,
      forceFeedbackBassShakerLfeQuieter: SIMHUB_BINDING,
    });
    expect(mockDeleteGlobalSettings).toHaveBeenCalledWith([
      "forceFeedbackWheelLfeIntensityIncrease",
      "forceFeedbackWheelLfeIntensityDecrease",
      "forceFeedbackHapticLfeIntensityIncrease",
      "forceFeedbackHapticLfeIntensityDecrease",
    ]);
  });

  it("should not overwrite an already-configured canonical key but still drop the retired key", () => {
    mockGetGlobalSettings.mockReturnValue({
      forceFeedbackWheelLfeLouder: SIMHUB_BINDING,
      forceFeedbackWheelLfeIntensityIncrease: KEYBOARD_BINDING,
    });

    migrateLfeIntensityBindingKeys();

    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    expect(mockDeleteGlobalSettings).toHaveBeenCalledWith(["forceFeedbackWheelLfeIntensityIncrease"]);
  });

  it("should drop a retired key whose value holds no parseable binding without carrying it over", () => {
    mockGetGlobalSettings.mockReturnValue({
      forceFeedbackHapticLfeIntensityDecrease: "",
    });

    migrateLfeIntensityBindingKeys();

    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    expect(mockDeleteGlobalSettings).toHaveBeenCalledWith(["forceFeedbackHapticLfeIntensityDecrease"]);
  });

  it("should be a no-op when no retired keys are present", () => {
    mockGetGlobalSettings.mockReturnValue({
      forceFeedbackWheelLfeLouder: KEYBOARD_BINDING,
      blackBoxLapTiming: KEYBOARD_BINDING,
    });

    migrateLfeIntensityBindingKeys();

    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    expect(mockDeleteGlobalSettings).not.toHaveBeenCalled();
  });
});
