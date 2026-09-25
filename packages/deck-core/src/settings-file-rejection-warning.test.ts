import { describe, expect, it } from "vitest";

import {
  evaluateSettingsFileRejectionWarning,
  SETTINGS_FILE_REJECTED_WARNING_ID,
} from "./settings-file-rejection-warning.js";

const PATH = "C:/Users/me/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.json";
const ASIDE =
  "C:/Users/me/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.corrupt-2026-08-27T04-38-11-000Z.json";
const REASON = "Expected double-quoted property name in JSON at position 9123 (line 327 column 120)";

describe("evaluateSettingsFileRejectionWarning", () => {
  it("is one page-wide error under its own id", () => {
    const warning = evaluateSettingsFileRejectionWarning({ path: PATH, reason: REASON, preservedAt: ASIDE });

    expect(warning.id).toBe(SETTINGS_FILE_REJECTED_WARNING_ID);
    expect(warning.level).toBe("error");
  });

  it("names the parse position, the restore from the deck software and the preserved copy", () => {
    const { message } = evaluateSettingsFileRejectionWarning({ path: PATH, reason: REASON, preservedAt: ASIDE });

    expect(message).toContain("line 327 column 120");
    expect(message).toContain("deck software keeps");
    expect(message).toContain(ASIDE);
    // The file name to restore it as, not the whole path again.
    expect(message).toContain("rename it to global-settings.json");
  });

  it("says the file is about to be overwritten when nothing could be preserved", () => {
    const { message } = evaluateSettingsFileRejectionWarning({ path: PATH, reason: REASON, preservedAt: undefined });

    expect(message).toContain("could not be set aside");
    expect(message).toContain(`copy ${PATH} somewhere safe`);
    expect(message).not.toContain("rename it");
  });

  it("does not begin with an emoji — ird-warnings renders the level icon itself", () => {
    const { message } = evaluateSettingsFileRejectionWarning({ path: PATH, reason: REASON, preservedAt: ASIDE });

    expect(message).toMatch(/^[A-Za-z]/);
  });
});
