import { describe, expect, it } from "vitest";

import { migrateLegacyActionToMode } from "./migrate-legacy-action.js";

describe("migrateLegacyActionToMode", () => {
  it("renames legacy action key to mode", () => {
    const result = migrateLegacyActionToMode({ action: "take-screenshot" });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({ mode: "take-screenshot" });
    expect(result.migrated.action).toBeUndefined();
  });

  it("preserves other settings keys during migration", () => {
    const result = migrateLegacyActionToMode({
      action: "take-screenshot",
      flagsOverlay: true,
      titleOverrides: { titleText: "X" },
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({
      mode: "take-screenshot",
      flagsOverlay: true,
      titleOverrides: { titleText: "X" },
    });
  });

  it("does not change settings that already use mode", () => {
    const result = migrateLegacyActionToMode({ mode: "take-screenshot" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ mode: "take-screenshot" });
  });

  it("keeps mode when both mode and action are present", () => {
    const result = migrateLegacyActionToMode({ mode: "video-timer", action: "take-screenshot" });

    expect(result.changed).toBe(false);
    expect(result.migrated.mode).toBe("video-timer");
  });

  it("handles empty raw settings", () => {
    const result = migrateLegacyActionToMode({});

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({});
  });

  it("handles null and undefined raw settings", () => {
    expect(migrateLegacyActionToMode(null).changed).toBe(false);
    expect(migrateLegacyActionToMode(null).migrated).toEqual({});
    expect(migrateLegacyActionToMode(undefined).changed).toBe(false);
    expect(migrateLegacyActionToMode(undefined).migrated).toEqual({});
  });

  it("handles non-object raw settings (string, number, boolean)", () => {
    expect(migrateLegacyActionToMode("string").changed).toBe(false);
    expect(migrateLegacyActionToMode(42).changed).toBe(false);
    expect(migrateLegacyActionToMode(true).changed).toBe(false);
  });
});
