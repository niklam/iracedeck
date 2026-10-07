import { describe, expect, it } from "vitest";

import {
  evaluateSettingsFileRejectionWarning,
  SETTINGS_FILE_REJECTED_WARNING_ID,
} from "./settings-file-rejection-warning.js";

const PATH = "C:/Users/me/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.json";
const ASIDE =
  "C:/Users/me/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.corrupt-2026-08-27T04-38-11-000Z.json";
// Node 20's wording — the Mirabox and Ulanzi hosts — which carries no line or column.
const REASON = "Expected double-quoted property name in JSON at position 9123";
const REJECTION = { path: PATH, reason: REASON, location: { line: 327, column: 1 }, preservedAt: ASIDE };

describe("evaluateSettingsFileRejectionWarning", () => {
  it("is one page-wide error under its own id", () => {
    const warning = evaluateSettingsFileRejectionWarning(REJECTION);

    expect(warning.id).toBe(SETTINGS_FILE_REJECTED_WARNING_ID);
    expect(warning.level).toBe("error");
  });

  it("names the store's own location, the parser's reason, what replaced the settings and the kept copy", () => {
    const { message } = evaluateSettingsFileRejectionWarning(REJECTION);

    expect(message).toContain("at, or just before, line 327, column 1");
    expect(message).toContain(REASON);
    expect(message).toContain("the copy your deck software keeps");
    expect(message).toContain("or with defaults if it had none");
    expect(message).toContain(ASIDE);
  });

  it("gives recovery steps that survive a running tray app and an existing file", () => {
    const { message } = evaluateSettingsFileRejectionWarning(REJECTION);

    expect(message).toContain("including from the system tray");
    expect(message).toContain("rename it to global-settings.json replacing the file there");
  });

  it("leaves the location out when there is none — valid JSON that is not a settings object", () => {
    const { message } = evaluateSettingsFileRejectionWarning({
      path: PATH,
      reason: "It is valid JSON but does not hold a settings object",
      preservedAt: ASIDE,
    });

    expect(message).toContain("(It is valid JSON but does not hold a settings object)");
    expect(message).not.toContain("line");
  });

  it("does not begin with an emoji — ird-warnings renders the level icon itself", () => {
    expect(evaluateSettingsFileRejectionWarning(REJECTION).message).toMatch(/^[A-Za-z]/);
  });
});
