import { describe, expect, it, vi } from "vitest";

import { unavailableLook } from "./unavailable-look.js";

vi.mock("@iracedeck/deck-core", () => ({
  hexToGrayscale: vi.fn((hex: string) => `grey(${hex})`),
}));

describe("unavailableLook", () => {
  it("greys every colour slot but the background", () => {
    const look = unavailableLook(
      { backgroundColor: "#102030", textColor: "#ffffff", graphic1Color: "#2ecc71" },
      { borderColor: "#00aaff" },
    );

    expect(look.colors).toEqual({
      backgroundColor: "#102030",
      textColor: "grey(#ffffff)",
      graphic1Color: "grey(#2ecc71)",
    });
  });

  it("greys the border's colour and keeps the rest of the border", () => {
    const look = unavailableLook({}, { enabled: true, borderWidth: 7, borderColor: "#00aaff", glowEnabled: false });

    expect(look.border).toEqual({ enabled: true, borderWidth: 7, borderColor: "grey(#00aaff)", glowEnabled: false });
  });

  it("asks for the faded artwork and title", () => {
    expect(unavailableLook({}, { borderColor: "#000000" }).dimmed).toBe(true);
  });

  it("leaves what it was given untouched", () => {
    const colors = { textColor: "#ffffff" };
    const border = { borderColor: "#00aaff" };

    unavailableLook(colors, border);

    expect(colors).toEqual({ textColor: "#ffffff" });
    expect(border).toEqual({ borderColor: "#00aaff" });
  });
});
