import { describe, expect, it } from "vitest";

// Throwaway positive control for #1492, never merged: one failing test in one
// shard must turn the required `Run tests` gate red.
describe("Run tests gate positive control (#1492)", () => {
  it("fails on purpose", () => {
    expect(1).toBe(2);
  });
});
