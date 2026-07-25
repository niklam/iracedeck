import { describe, expect, it } from "vitest";

import { normalizeCornerName, normalizeTrackKey, slugifyCornerName } from "./normalize.js";

describe("normalizeCornerName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeCornerName("  Hell   Corner ")).toBe("Hell Corner");
  });

  it("expands T<n> shorthand to Turn <n>", () => {
    expect(normalizeCornerName("T5")).toBe("Turn 5");
    expect(normalizeCornerName("t11")).toBe("Turn 11");
  });

  it("leaves full names untouched", () => {
    expect(normalizeCornerName("Turn 5")).toBe("Turn 5");
    expect(normalizeCornerName("Eau Rouge")).toBe("Eau Rouge");
    // Not a bare T<n> — embedded digits stay as-is.
    expect(normalizeCornerName("Expo 92")).toBe("Expo 92");
  });
});

describe("slugifyCornerName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyCornerName("Eau Rouge")).toBe("eau-rouge");
    expect(slugifyCornerName("Forest's Elbow")).toBe("forest-s-elbow");
  });

  it("normalizes T<n> and Turn <n> to the same slug", () => {
    expect(slugifyCornerName("T5")).toBe("turn-5");
    expect(slugifyCornerName("Turn 5")).toBe("turn-5");
  });

  it("strips diacritics and symbols", () => {
    expect(slugifyCornerName("Hasseröder")).toBe("hasseroder");
    expect(slugifyCornerName("180°")).toBe("180");
  });
});

describe("normalizeTrackKey", () => {
  it("treats hyphens, underscores, and spaces as equivalent", () => {
    expect(normalizeTrackKey("cota-gp")).toBe("cota gp");
    expect(normalizeTrackKey("Cota GP")).toBe("cota gp");
  });

  it("collapses runs of separators", () => {
    expect(normalizeTrackKey("watkinsglen  2021--fullcourse")).toBe("watkinsglen 2021 fullcourse");
  });
});
