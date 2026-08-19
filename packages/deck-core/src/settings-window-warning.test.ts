import { describe, expect, it } from "vitest";

import {
  evaluateSettingsWindowWarnings,
  SETTINGS_WINDOW_OPEN_WARNING_ID,
  SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE,
  SETTINGS_WINDOW_SERVER_WARNING_ID,
  settingsWindowWarningScope,
} from "./settings-window-warning.js";

const STORE_PATH = "C:/Users/x/AppData/Local/iRaceDeck/Settings/Stream Deck/global-settings.json";

const serverFailed = { stage: "server", ok: false, error: new Error("EADDRINUSE") } as const;
const openFailed = { stage: "open", ok: false, error: new Error("no browser") } as const;

function byId(warnings: ReturnType<typeof evaluateSettingsWindowWarnings>, id: string) {
  return warnings.find((w) => w.id === id);
}

describe("evaluateSettingsWindowWarnings", () => {
  it("raises both banners when the settings service fails to start", () => {
    // One condition, two placements: the error explains the whole page, the
    // warning marks the Open Settings button unusable a full scroll below it.
    const result = evaluateSettingsWindowWarnings(serverFailed, { storePath: STORE_PATH });

    expect(result.map((w) => w.id).sort()).toEqual(
      [SETTINGS_WINDOW_OPEN_WARNING_ID, SETTINGS_WINDOW_SERVER_WARNING_ID].sort(),
    );
    expect(byId(result, SETTINGS_WINDOW_SERVER_WARNING_ID)?.level).toBe("error");
    expect(byId(result, SETTINGS_WINDOW_OPEN_WARNING_ID)?.level).toBe("warning");
  });

  it("raises only the button banner when the server is up but nothing would open the window", () => {
    const result = evaluateSettingsWindowWarnings(openFailed, { storePath: STORE_PATH });

    expect(result.map((w) => w.id)).toEqual([SETTINGS_WINDOW_OPEN_WARNING_ID]);
    expect(result[0]?.level).toBe("warning");
  });

  it("says different things at the button depending on which failure caused it", () => {
    const blocked = byId(evaluateSettingsWindowWarnings(serverFailed, {}), SETTINGS_WINDOW_OPEN_WARNING_ID);
    const noBrowser = byId(evaluateSettingsWindowWarnings(openFailed, {}), SETTINGS_WINDOW_OPEN_WARNING_ID);

    expect(blocked?.message).not.toBe(noBrowser?.message);
    // A dead service is not the browser's fault; saying so would send the user
    // off reinstalling Edge.
    expect(blocked?.message).not.toContain("browser");
  });

  it("keeps the button note short, pointing at the error rather than repeating it", () => {
    // Both are on screen at once when the service is down, so the note must not
    // restate the cause, the advice, or the settings-file path.
    const blocked = byId(
      evaluateSettingsWindowWarnings(serverFailed, { storePath: STORE_PATH }),
      SETTINGS_WINDOW_OPEN_WARNING_ID,
    );

    expect(blocked?.message).not.toContain(STORE_PATH);
    expect(blocked?.message.length).toBeLessThan(SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE.length);
  });

  it("names the settings file on the banners that are the user's only lead", () => {
    const server = byId(
      evaluateSettingsWindowWarnings(serverFailed, { storePath: STORE_PATH }),
      SETTINGS_WINDOW_SERVER_WARNING_ID,
    );
    const open = byId(
      evaluateSettingsWindowWarnings(openFailed, { storePath: STORE_PATH }),
      SETTINGS_WINDOW_OPEN_WARNING_ID,
    );

    expect(server?.message).toContain(STORE_PATH);
    expect(open?.message).toContain(STORE_PATH);
  });

  it("omits the settings-file sentence when the path is not known yet", () => {
    const server = byId(evaluateSettingsWindowWarnings(serverFailed, {}), SETTINGS_WINDOW_SERVER_WARNING_ID);

    expect(server?.message).not.toContain("settings file");
  });

  it("warns that Property Inspector edits are discarded while the service is down, but not when only the open failed", () => {
    // With no settings service a PI has no channel to the plugin and falls back
    // to the deck host's copy, which the plugin ignores outright once its store
    // is ready — so a binding the user changes there is echoed as saved and
    // never reaches the plugin. A failed open leaves the service up, so edits
    // work normally and saying otherwise would be a false alarm.
    const server = byId(evaluateSettingsWindowWarnings(serverFailed, {}), SETTINGS_WINDOW_SERVER_WARNING_ID);
    const open = byId(evaluateSettingsWindowWarnings(openFailed, {}), SETTINGS_WINDOW_OPEN_WARNING_ID);

    expect(server?.message).toContain("Property Inspector");
    expect(open?.message).not.toContain("Property Inspector");
  });

  it("returns nothing on either success, so the caller clears that scope", () => {
    expect(evaluateSettingsWindowWarnings({ stage: "server", ok: true }, { storePath: STORE_PATH })).toEqual([]);
    expect(
      evaluateSettingsWindowWarnings({ stage: "open", ok: true, launch: "app-window" }, { storePath: STORE_PATH }),
    ).toEqual([]);
  });

  it("starts no message with an emoji — ird-warnings prepends its own level icon", () => {
    const messages = [
      ...evaluateSettingsWindowWarnings(serverFailed, {}),
      ...evaluateSettingsWindowWarnings(openFailed, {}),
    ];

    expect(messages.length).toBeGreaterThan(0);

    for (const { message } of messages) {
      expect(message).not.toMatch(/^\p{Extended_Pictographic}/u);
    }
  });
});

describe("settingsWindowWarningScope", () => {
  it("lets a server report speak for both records, since a dead service decides both", () => {
    expect([...settingsWindowWarningScope("server")].sort()).toEqual(
      [SETTINGS_WINDOW_OPEN_WARNING_ID, SETTINGS_WINDOW_SERVER_WARNING_ID].sort(),
    );
  });

  it("limits an open report to its own record, so one press cannot clear the page-wide error", () => {
    expect(settingsWindowWarningScope("open")).toEqual([SETTINGS_WINDOW_OPEN_WARNING_ID]);
  });
});
