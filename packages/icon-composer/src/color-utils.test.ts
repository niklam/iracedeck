import { describe, expect, it } from "vitest";

import { hexToGrayscale } from "./color-utils.js";

describe("hexToGrayscale", () => {
  it("should convert red to grayscale", () => {
    // Red (255, 0, 0) -> 0.299 * 255 = 76.245 -> #4c4c4c
    expect(hexToGrayscale("#ff0000")).toBe("#4c4c4c");
  });

  it("should convert green to grayscale", () => {
    // Green (0, 255, 0) -> 0.587 * 255 = 149.685 -> #969696
    expect(hexToGrayscale("#00ff00")).toBe("#969696");
  });

  it("should convert blue to grayscale", () => {
    // Blue (0, 0, 255) -> 0.114 * 255 = 29.07 -> #1d1d1d
    expect(hexToGrayscale("#0000ff")).toBe("#1d1d1d");
  });

  it("should convert white to white", () => {
    expect(hexToGrayscale("#ffffff")).toBe("#ffffff");
  });

  it("should convert black to black", () => {
    expect(hexToGrayscale("#000000")).toBe("#000000");
  });

  it("should handle short hex format", () => {
    // #f00 = #ff0000 -> #4c4c4c
    expect(hexToGrayscale("#f00")).toBe("#4c4c4c");
  });

  it("should handle hex without #", () => {
    expect(hexToGrayscale("ff0000")).toBe("#4c4c4c");
  });

  it("should handle upper-case hex", () => {
    expect(hexToGrayscale("#FF0000")).toBe("#4c4c4c");
  });

  it("should return invalid formats unchanged", () => {
    expect(hexToGrayscale("#gg0000")).toBe("#gg0000");
    expect(hexToGrayscale("red")).toBe("red");
    expect(hexToGrayscale("#ff00")).toBe("#ff00");
    expect(hexToGrayscale("")).toBe("");
  });
});
