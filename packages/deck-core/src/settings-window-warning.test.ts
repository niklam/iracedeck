import { describe, expect, it } from "vitest";

import { evaluateSettingsWindowWarning, SETTINGS_WINDOW_WARNING_ID } from "./settings-window-warning.js";

const STORE_PATH = "C:/Users/x/AppData/Local/iRaceDeck/Settings/Stream Deck/global-settings.json";

describe("evaluateSettingsWindowWarning", () => {
  it("reports an error when the settings server failed to start", () => {
    const result = evaluateSettingsWindowWarning(
      { stage: "server", ok: false, error: new Error("EADDRINUSE") },
      { storePath: STORE_PATH },
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe(SETTINGS_WINDOW_WARNING_ID);
    expect(result?.level).toBe("error");
  });

  it("reports a warning when the server is up but nothing would open the window", () => {
    const result = evaluateSettingsWindowWarning(
      { stage: "open", ok: false, error: new Error("no browser") },
      { storePath: STORE_PATH },
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe(SETTINGS_WINDOW_WARNING_ID);
    expect(result?.level).toBe("warning");
  });

  it("gives the two failures different messages, so the one banner says which happened", () => {
    const server = evaluateSettingsWindowWarning({ stage: "server", ok: false, error: undefined }, {});
    const open = evaluateSettingsWindowWarning({ stage: "open", ok: false, error: undefined }, {});

    expect(server?.message).not.toBe(open?.message);
  });

  it("names the settings file so the user has something to act on", () => {
    const server = evaluateSettingsWindowWarning(
      { stage: "server", ok: false, error: undefined },
      {
        storePath: STORE_PATH,
      },
    );
    const open = evaluateSettingsWindowWarning(
      { stage: "open", ok: false, error: undefined },
      {
        storePath: STORE_PATH,
      },
    );

    expect(server?.message).toContain(STORE_PATH);
    expect(open?.message).toContain(STORE_PATH);
  });

  it("warns that Property Inspector edits are discarded while the service is down, but not when only the open failed", () => {
    // With no settings service a PI has no channel to the plugin and falls back
    // to the deck host's copy, which the plugin ignores outright once its store
    // is ready — so a binding the user changes there is echoed as saved and
    // never reaches the plugin. A failed open leaves the service up, so edits
    // work normally and saying otherwise would be a false alarm.
    const server = evaluateSettingsWindowWarning({ stage: "server", ok: false, error: undefined }, {});
    const open = evaluateSettingsWindowWarning({ stage: "open", ok: false, error: undefined }, {});

    expect(server?.message).toContain("Property Inspector");
    expect(open?.message).not.toContain("Property Inspector");
  });

  it("omits the settings-file sentence when the path is not known yet", () => {
    const result = evaluateSettingsWindowWarning({ stage: "server", ok: false, error: undefined }, {});

    expect(result?.message).not.toContain("settings file");
  });

  it("returns null on either success so the caller clears the banner", () => {
    expect(evaluateSettingsWindowWarning({ stage: "server", ok: true }, { storePath: STORE_PATH })).toBeNull();
    expect(
      evaluateSettingsWindowWarning({ stage: "open", ok: true, launch: "app-window" }, { storePath: STORE_PATH }),
    ).toBeNull();
  });

  it("starts neither message with an emoji — ird-warnings prepends its own level icon", () => {
    const messages = [
      evaluateSettingsWindowWarning({ stage: "server", ok: false, error: undefined }, {})?.message,
      evaluateSettingsWindowWarning({ stage: "open", ok: false, error: undefined }, {})?.message,
    ];

    for (const message of messages) {
      expect(message).toBeDefined();
      expect(message).not.toMatch(/^\p{Extended_Pictographic}/u);
    }
  });
});
