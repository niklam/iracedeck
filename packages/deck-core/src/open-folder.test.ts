import { describe, expect, it } from "vitest";

import { explorerSelectArgs } from "./open-folder.js";

describe("explorerSelectArgs", () => {
  it("uses Explorer's documented /select,<quoted path> form so a path with a space survives", () => {
    expect(
      explorerSelectArgs("C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\global-settings.json"),
    ).toEqual([
      '/select,"C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\global-settings.json"',
    ]);
  });

  it("quotes unconditionally — still one argument, and no shell is involved", () => {
    expect(explorerSelectArgs("C:\\tmp\\a.json")).toEqual(['/select,"C:\\tmp\\a.json"']);
  });
});
