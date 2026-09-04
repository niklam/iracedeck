import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/race-engineer-settings.ejs` (not a fixture) to pin
 * the voice-packs section added in #1034.
 *
 * Two properties are load-bearing and easy to break silently:
 *
 * 1. The section is settings-window ONLY. Its Rescan button is a `sendToPlugin`
 *    command routed by the settings-window command handler; from a Property
 *    Inspector the same frame goes to that PI's action instead, where nothing
 *    handles it — so the button would render and do nothing.
 * 2. It only renders when the flag is passed to THIS include. The window nests
 *    it inside an `accordion` include's object literal, which is evaluated in
 *    the page's own scope, so a caller that forgets `{ settingsWindow: true }`
 *    gets a silently empty section — exactly the bug this file guards.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const templatePath = path.join(partialsDir, "race-engineer-settings.ejs");
const windowTemplate = path.resolve(
  partialsDir,
  "../../iracing-actions/src/actions/settings-window/settings-window.ejs",
);

function render(locals: Record<string, unknown>): string {
  return ejs.render(readFileSync(templatePath, "utf-8"), locals, { filename: templatePath });
}

describe("race-engineer-settings voice packs (issue #1034)", () => {
  it("renders the installed-voices list and rescan button in the settings window", () => {
    const html = render({ settingsWindow: true });

    expect(html).toContain("<ird-voice-pack-list");
    expect(html).toContain("<ird-voice-pack-refresh");
  });

  it("binds the list to the run-scoped _voicePacks global", () => {
    expect(render({ settingsWindow: true })).toContain('packs="_voicePacks"');
  });

  it("renders the downloadable-packs catalog and the packs-folder shortcut, settings-window only (#1100)", () => {
    const html = render({ settingsWindow: true });

    expect(html).toContain("<ird-voice-pack-catalog");
    expect(html).toContain('status="_voicePackStatus"');
    expect(html).toContain("<ird-open-voice-packs-folder");

    const bare = render({});

    expect(bare).not.toContain("ird-voice-pack-catalog");
    expect(bare).not.toContain("ird-open-voice-packs-folder");
  });

  it("tells the user where packs live, so a sideload needs no documentation lookup", () => {
    const html = render({ settingsWindow: true });

    expect(html).toContain("LOCALAPPDATA");
    expect(html).toContain("Race Engineer");
    expect(html).toContain("Voices");
  });

  it("renders NOTHING voice-pack related outside the settings window", () => {
    const html = render({});

    expect(html).not.toContain("ird-voice-pack-list");
    expect(html).not.toContain("ird-voice-pack-refresh");
  });

  it("still renders the plain Race Engineer controls on both surfaces", () => {
    for (const locals of [{}, { settingsWindow: true }]) {
      expect(render(locals)).toContain('<ird-voice-select setting="raceEngineerVoice"');
    }
  });

  it("anchors the voice dropdown to `default`, so an installed pack cannot win by sorting first", () => {
    // The counterpart of `resolveActiveRaceEngineerVoice`'s anchor: without this
    // attribute the dropdown falls to the first option and disagrees with what
    // the plugin actually plays (issue #1034).
    for (const locals of [{}, { settingsWindow: true }]) {
      expect(render(locals)).toContain('voices="_raceEngineerVoices" labels="_voiceLabels" default="default"');
    }
  });

  it("the settings window passes settingsWindow into THIS include, not just into the accordion", () => {
    // The nested-include scope trap: `content: include('x')` inside another
    // include's object literal is evaluated in the page's scope and inherits
    // nothing, so the flag has to be handed to the inner include explicitly.
    const source = readFileSync(windowTemplate, "utf-8");

    expect(source).toContain("include('race-engineer-settings', { settingsWindow: true })");
  });
});
