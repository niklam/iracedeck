import { describe, expect, it } from "vitest";

import { ELEVATION_WARNING_ID, evaluateElevationWarning } from "./elevation-warning.js";

describe("evaluateElevationWarning", () => {
  it("returns a warning record when there is a mismatch", () => {
    const result = evaluateElevationWarning({ mismatch: true });
    expect(result).not.toBeNull();
    expect(result?.id).toBe(ELEVATION_WARNING_ID);
    expect(result?.level).toBe("warning");
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it("returns null when there is no mismatch", () => {
    expect(evaluateElevationWarning({ mismatch: false })).toBeNull();
  });
});
