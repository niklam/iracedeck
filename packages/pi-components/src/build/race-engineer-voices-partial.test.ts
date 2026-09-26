import { DEFAULT_RACE_ENGINEER_VOICE } from "@iracedeck/deck-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/race-engineer-settings.ejs` (not a fixture) to pin
 * where the voice controls live: the Race Engineer Voice dropdown stays here,
 * and the voice-pack block (#1034, #1100) does not. Since #1145 that block is
 * `partials/voice-packs.ejs`, the settings window's Voice Packs card, pinned by
 * `voice-packs-partial.test.ts` — so nothing voice-pack related may reappear in
 * this partial on either surface.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const templatePath = path.join(partialsDir, "race-engineer-settings.ejs");

function render(locals: Record<string, unknown>): string {
  return ejs.render(readFileSync(templatePath, "utf-8"), locals, { filename: templatePath });
}

describe("race-engineer-settings voice controls (#1034, #1145)", () => {
  it("renders nothing voice-pack related on either surface — the Voice Packs card owns it (#1145)", () => {
    for (const locals of [{}, { settingsWindow: true }]) {
      const html = render(locals);

      expect(html).not.toContain("ird-voice-pack");
      expect(html).not.toContain("ird-open-voice-packs-folder");
    }
  });

  it("still renders the plain Race Engineer controls on both surfaces", () => {
    for (const locals of [{}, { settingsWindow: true }]) {
      expect(render(locals)).toContain('<ird-voice-select setting="raceEngineerVoice"');
    }
  });

  it("anchors the voice dropdown to `default::default`, so an installed pack cannot win by sorting first", () => {
    // The counterpart of `resolveActiveRaceEngineerVoice`'s anchor: without this
    // attribute the dropdown falls to the first option and disagrees with what
    // the plugin actually plays (issue #1034). The anchor is the managed pack's
    // voice by its composite id, `DEFAULT_RACE_ENGINEER_VOICE` (#1144); a bare
    // `default` would match no option the plugin publishes.
    for (const locals of [{}, { settingsWindow: true }]) {
      expect(render(locals)).toContain(
        `voices="_raceEngineerVoices" labels="_voiceLabels" default="${DEFAULT_RACE_ENGINEER_VOICE}"`,
      );
    }
  });
});
