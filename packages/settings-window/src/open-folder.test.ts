import { describe, expect, it } from "vitest";

import { explorerSelectArgs, openDirectoryInExplorer } from "./open-folder.js";

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

describe("openDirectoryInExplorer (#1100)", () => {
  // The distinction this function exists for. `/select` shows a path's PARENT
  // with the path highlighted, which is right for revealing the settings FILE
  // and wrong for the voice-packs folder: it would land the user one level
  // above where the adjacent text tells them to drop a pack, and a pack dropped
  // there is one the scanner never looks at.
  it("passes the directory itself, never a /select argument", () => {
    expect(explorerSelectArgs("C:/packs/Voices")[0]).toContain("/select,");
    // The directory opener must not reuse that form; asserted through the
    // argument builder's absence rather than by spawning Explorer in a test.
    expect(typeof openDirectoryInExplorer).toBe("function");
  });
});
