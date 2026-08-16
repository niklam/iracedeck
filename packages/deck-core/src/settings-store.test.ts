import { describe, expect, it } from "vitest";

import { resolveSettingsStorePath, settingsStoreFolderName } from "./settings-store.js";

describe("settingsStoreFolderName", () => {
  it("maps the plugin platform id to a human-readable per-ecosystem folder", () => {
    expect(settingsStoreFolderName("stream-deck")).toBe("Stream Deck");
    expect(settingsStoreFolderName("mirabox")).toBe("Mirabox");
    expect(settingsStoreFolderName("ulanzi")).toBe("Ulanzi");
  });

  it("passes an unknown platform id through so two unknown ecosystems still get separate files", () => {
    expect(settingsStoreFolderName("something-new")).toBe("something-new");
  });
});

describe("resolveSettingsStorePath", () => {
  it("defaults to %LOCALAPPDATA%\\iRaceDeck\\Settings\\<ecosystem>\\global-settings.json", () => {
    const p = resolveSettingsStorePath({
      platform: "stream-deck",
      env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" },
    });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Stream Deck/global-settings.json");
  });

  it("falls back to USERPROFILE\\AppData\\Local when LOCALAPPDATA is unset", () => {
    const p = resolveSettingsStorePath({ platform: "mirabox", env: { USERPROFILE: "C:\\Users\\n" } });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.json");
  });

  it("honours IRACEDECK_SETTINGS_PATH as a full file path override (dev / fresh-install testing)", () => {
    const p = resolveSettingsStorePath({
      platform: "ulanzi",
      env: { LOCALAPPDATA: "C:\\x", IRACEDECK_SETTINGS_PATH: "D:\\test\\fresh.json" },
    });

    expect(p).toBe("D:\\test\\fresh.json");
  });
});
