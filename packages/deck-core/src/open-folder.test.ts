import { describe, expect, it } from "vitest";

import { explorerSelectArgs } from "./open-folder.js";

describe("explorerSelectArgs", () => {
  it("selects the file in Explorer — one argument, no shell quoting", () => {
    expect(
      explorerSelectArgs("C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\global-settings.json"),
    ).toEqual([
      "/select,C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\global-settings.json",
    ]);
  });
});
