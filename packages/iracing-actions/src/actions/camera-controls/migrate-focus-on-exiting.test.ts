import { describe, expect, it } from "vitest";

import { migrateFocusOnExitingToMostExciting } from "./migrate-focus-on-exiting.js";

describe("migrateFocusOnExitingToMostExciting", () => {
  it("rewrites target=focus-on-exiting to target=focus-on-most-exciting", () => {
    const result = migrateFocusOnExitingToMostExciting({ target: "focus-on-exiting" });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({ target: "focus-on-most-exciting" });
  });

  it("preserves other settings keys during migration", () => {
    const result = migrateFocusOnExitingToMostExciting({
      target: "focus-on-exiting",
      direction: "next",
      position: 3,
      carNumber: 0,
      cameraState: 0,
      cameraGroup: 9,
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({
      target: "focus-on-most-exciting",
      direction: "next",
      position: 3,
      carNumber: 0,
      cameraState: 0,
      cameraGroup: 9,
    });
  });

  it("does not change settings whose target is already focus-on-most-exciting", () => {
    const result = migrateFocusOnExitingToMostExciting({ target: "focus-on-most-exciting" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ target: "focus-on-most-exciting" });
  });

  it("does not touch unrelated targets", () => {
    const result = migrateFocusOnExitingToMostExciting({ target: "focus-on-leader", position: 1 });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ target: "focus-on-leader", position: 1 });
  });

  it("handles missing target key", () => {
    const result = migrateFocusOnExitingToMostExciting({ direction: "next" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ direction: "next" });
  });

  it("handles empty raw settings", () => {
    const result = migrateFocusOnExitingToMostExciting({});

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({});
  });

  it("handles null and undefined raw settings", () => {
    expect(migrateFocusOnExitingToMostExciting(null)).toEqual({ migrated: {}, changed: false });
    expect(migrateFocusOnExitingToMostExciting(undefined)).toEqual({ migrated: {}, changed: false });
  });

  it("handles non-object raw settings (string, number, boolean)", () => {
    expect(migrateFocusOnExitingToMostExciting("string").changed).toBe(false);
    expect(migrateFocusOnExitingToMostExciting(42).changed).toBe(false);
    expect(migrateFocusOnExitingToMostExciting(true).changed).toBe(false);
  });
});
