import ejs from "ejs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/accordion.ejs` (not a fixture) — it wraps a
 * section in every one of the 35 action PIs, and since #992 it has a second,
 * flat "card" mode for the settings window. Both must keep working.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

function render(template: string, data: Record<string, unknown> = {}): string {
  return ejs.render(template, data, { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") });
}

// A partial that reads build data `require()`s it from the including page's
// `data/` folder (`iracing-actions`' `src/actions/data/` in the real build).
// These tests pin setting keys, not the data, so they hand it a fixture; the
// committed data is rendered through the partials beside it, in
// `iracing-actions`' `src/pi-templates/template-data.test.ts` (#1375).
const DATA_FIXTURES: Record<string, unknown> = {
  "./data/profiles.json": [{ name: "iRaceDeck Default SD", deviceType: 0, displayName: "iRaceDeck Default" }],
};
const dataRequire = (spec: string): unknown => {
  if (!(spec in DATA_FIXTURES)) throw new Error(`unexpected require: ${spec}`);

  return DATA_FIXTURES[spec];
};
const withRequire = { require: dataRequire };

describe("accordion.ejs", () => {
  it("renders a collapsible <details> by default (the PI mode)", () => {
    const html = render("<%- include('accordion', { title: 'Title Defaults', content: '<p>body</p>' }) %>");

    expect(html).toContain('<details class="ird-collapsible" data-accordion-id="Title Defaults"');
    expect(html).toContain("<p>body</p>");
  });

  it("renders a flat card, not a <details>, when settingsWindow is set (#992)", () => {
    const html = render(
      "<%- include('accordion', { title: 'Title Defaults', content: '<p>body</p>', settingsWindow: true }) %>",
    );

    expect(html).not.toContain("<details");
    expect(html).toContain('class="ird-sw-card"');
    expect(html).toContain("Title Defaults");
    expect(html).toContain("<p>body</p>");
  });

  it("inherits settingsWindow through a nesting partial (EJS include scope), so global-* partials need no changes", () => {
    // A partial that itself includes accordion WITHOUT forwarding the flag —
    // exactly what global-title-defaults.ejs & co. do. Written to a temp views
    // dir searched alongside the real partials dir.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ird-accordion-nest-"));

    try {
      writeFileSync(path.join(tmp, "nesting.ejs"), "<%- include('accordion', { title: 'Nested', content: 'x' }) %>");

      const html = ejs.render(
        "<%- include('nesting', { settingsWindow: true }) %>",
        {},
        { views: [tmp, partialsDir], filename: path.join(tmp, "_test.ejs") },
      );

      expect(html).toContain('class="ird-sw-card"');
      expect(html).not.toContain("<details");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Renders the REAL per-group common-settings partials. The `global-common-settings`
 * assembler that used to gather them into one PI accordion is gone since #1003 —
 * the action PIs no longer carry plugin-global settings at all, and the settings
 * window includes each group directly. These tests pin every setting key so the
 * window can't silently lose a control.
 */
describe("global-common-* group partials", () => {
  it("each per-group partial renders on its own without an accordion, for the settings window", () => {
    const groups: Record<string, string[]> = {
      "global-common-window-focus": ["focusIRacingWindow"],
      "global-common-simhub": ["simHubHost", "simHubPort"],
      "global-common-dual-press": ["dualPressThresholdMs", "dualPressDirections"],
      "global-common-press-sounds": ["pressSound"],
      "global-common-replay": ["replayJumpPlayback", "fastestLapSearchDelayMs"],
      "global-common-chat": ["chatOpenToPasteDelayMs", "chatPasteToEnterDelayMs", "chatEnterToCloseDelayMs"],
      "global-common-updates": ["changelogNotification"],
      "global-common-diagnostics": ["debugLogging", "_settingsStorePath", "_trackDataPath"],
      "global-profile-auto-switch": [
        "profileAutoSwitchEnabled",
        "profileForSessionKindTest",
        "profileForSessionKindPractice",
        "profileForSessionKindQualifying",
        "profileForSessionKindRace",
        "profileForSessionKindReplay",
      ],
    };

    for (const [partial, keys] of Object.entries(groups)) {
      const html = render(`<%- include('${partial}') %>`, withRequire);

      expect(html, partial).not.toContain("<details");

      for (const key of keys) expect(html, `${partial} → ${key}`).toContain(`setting="${key}"`);
    }
  });

  // `focusIRacingWindow` stopped being a boolean in #977 — a checkbox here would
  // write `true`/`false` back over a mode the plugin can no longer distinguish
  // from "always".
  it("renders Focus iRacing as a three-way mode select (#977)", () => {
    const html = render("<%- include('global-common-window-focus') %>");

    expect(html).toContain('<sdpi-select setting="focusIRacingWindow"');
    expect(html).toContain('<option value="always">Always</option>');
    expect(html).toContain('<option value="required">When required</option>');
    expect(html).toContain('<option value="never">Never</option>');
    // A regex, not a literal: the checkbox this replaced spread its attributes
    // over several lines, so a single-line literal would pass vacuously against
    // the very markup it exists to forbid.
    expect(html).not.toMatch(/<sdpi-checkbox[^>]*setting="focusIRacingWindow"/);
  });
});

describe("the disconnected look (#1599)", () => {
  it("the Window Focus card no longer carries the retired Connection item", () => {
    const html = render("<%- include('global-common-window-focus') %>");

    expect(html).not.toContain("disableWhenDisconnected");
    expect(html).not.toContain('label="Connection"');
    expect(html).not.toContain("<sdpi-checkbox");
    // What stays: the Focus iRacing select, and only it.
    expect((html.match(/<sdpi-item /g) ?? []).length).toBe(1);
  });

  it("global-disconnected-look renders one global checkbox for showDisconnectedState with no default attribute", () => {
    const html = render("<%- include('global-disconnected-look') %>");

    // The truthy-attribute trap: `default="false"` renders CHECKED, so the
    // off-by-default setting carries no `default` attribute at all.
    expect(html).toContain(
      '<sdpi-checkbox setting="showDisconnectedState" label="Dim keys that need iRacing" global></sdpi-checkbox>',
    );
    expect(html).not.toMatch(/<sdpi-checkbox[^>]*default=/);
    expect((html.match(/setting="/g) ?? []).length).toBe(1);
    expect(html).not.toContain("disableWhenDisconnected");
  });

  it("says presses still go through and names the keys that keep their look", () => {
    const text = render("<%- include('global-disconnected-look') %>").replace(/\s+/g, " ");

    expect(text).toContain("Pressing one still sends the press.");

    for (const name of ["Pit Crew", "Switch Profile", "Capture CPU Profile", "Race Engineer and Radar volume keys"]) {
      expect(text, name).toContain(name);
    }
  });

  it("is a collapsible accordion in the PI mode and a flat card in the settings window", () => {
    const pi = render("<%- include('global-disconnected-look') %>");
    const win = render("<%- include('global-disconnected-look', { settingsWindow: true }) %>");

    expect(pi).toContain('<details class="ird-collapsible" data-accordion-id="Global Disconnected Keys"');
    expect(win).not.toContain("<details");
    expect(win).toContain('class="ird-sw-card"');
    expect(win).toContain("Disconnected Keys");
    expect(win).toContain('setting="showDisconnectedState"');
  });
});

describe("global-common-diagnostics.ejs storage row (#993)", () => {
  it("shows the settings file path on both surfaces, and the Open folder button only in the window", () => {
    const pi = render("<%- include('global-common-diagnostics') %>");
    const win = render("<%- include('global-common-diagnostics', { settingsWindow: true }) %>");

    expect(pi).toContain('setting="_settingsStorePath"');
    expect(pi).not.toContain("<ird-open-folder");
    expect(win).toContain('setting="_settingsStorePath"');
    expect(win).toContain("<ird-open-folder");
  });

  it("shows the track data path on both surfaces, and its Open folder button only in the window (#1112)", () => {
    const pi = render("<%- include('global-common-diagnostics') %>");
    const win = render("<%- include('global-common-diagnostics', { settingsWindow: true }) %>");

    // A disabled textfield, like the settings-file row: the plugin writes the
    // path, the page only shows it.
    expect(pi).toMatch(/<sdpi-textfield setting="_trackDataPath" global disabled>/);
    expect(win).toMatch(/<sdpi-textfield setting="_trackDataPath" global disabled>/);
    expect(pi).not.toContain("<ird-open-track-data-folder");
    expect(win).toContain("<ird-open-track-data-folder");
  });

  it("keeps each Open folder button under its own row (#1112)", () => {
    const win = render("<%- include('global-common-diagnostics', { settingsWindow: true }) %>");
    const at = (needle: string): number => {
      const index = win.indexOf(needle);

      expect(index, needle).toBeGreaterThanOrEqual(0);

      return index;
    };

    expect(at('setting="_settingsStorePath"')).toBeLessThan(at("<ird-open-folder"));
    expect(at("<ird-open-folder")).toBeLessThan(at('setting="_trackDataPath"'));
    expect(at('setting="_trackDataPath"')).toBeLessThan(at("<ird-open-track-data-folder"));
  });

  it("renders the Capture CPU profile controls only in the window (#1338)", () => {
    const pi = render("<%- include('global-common-diagnostics') %>");
    const win = render("<%- include('global-common-diagnostics', { settingsWindow: true }) %>");

    for (const tag of ["<ird-capture-cpu-profile", "<ird-open-profiles-folder", "<ird-cpu-profile-status"]) {
      expect(pi).not.toContain(tag);
      expect(win).toContain(tag);
    }
  });
});

/**
 * The Race Engineer / Pit Crew plugin-wide settings used to be authored
 * inline in pit-crew.ejs. They are now three partials (#992) so the settings
 * window can show them on a Race Engineer tab while pit-crew.ejs keeps its
 * three accordions. Pin representative keys per partial so neither surface
 * can silently lose a control. The Callouts card, `race-engineer-callouts.ejs`,
 * is tested on its own in `race-engineer-callouts-partial.test.ts` (#1700).
 */
describe("race-engineer partials", () => {
  it("race-engineer-settings emits the live toggles, startup policies, voice, name, device, volumes and radio frame", () => {
    const html = render("<%- include('race-engineer-settings') %>", withRequire);

    for (const key of [
      "pitCrewRaceEngineerEnabled",
      "pitCrewRaceEngineerStartupPolicy",
      "pitCrewRadarEnabled",
      "pitCrewRadarStartupPolicy",
      "raceEngineerVoice",
      "driverName",
      "audioOutputDevice",
      "raceEngineerVolume",
      "backgroundVolume",
      "radarVolume",
      "raceEngineerRadioBeeps",
      "raceEngineerPitAmbience",
    ]) {
      expect(html, key).toContain(`setting="${key}"`);
    }

    expect(html).not.toContain("<details");
  });

  // The two halves of the radio frame (issue #1064) are opt-OUTs: both default
  // on, so each checkbox must carry `default="true"` (the one value that renders
  // checked — `default="false"` is the trap, see stream-deck-actions.md) and be
  // `global`, and the pair sits under Background Volume because that slider is
  // still the level control for both.
  it("race-engineer-settings puts the radio-frame opt-outs under Background Volume, both global and default on", () => {
    const html = render("<%- include('race-engineer-settings') %>", withRequire);

    const frameItem = html.match(/<sdpi-item label="Radio Frame">[\s\S]*?<\/sdpi-item>/)?.[0];
    expect(frameItem).toBeDefined();
    expect(frameItem).toContain(
      '<sdpi-checkbox setting="raceEngineerRadioBeeps" label="Radio beeps" global default="true"></sdpi-checkbox>',
    );
    expect(frameItem).toContain(
      '<sdpi-checkbox setting="raceEngineerPitAmbience" label="Pit ambience" global default="true"></sdpi-checkbox>',
    );
    expect(html).not.toContain('default="false"');

    const background = html.indexOf('setting="backgroundVolume"');
    const frame = html.indexOf('<sdpi-item label="Radio Frame">');
    const radar = html.indexOf('setting="radarVolume"');
    expect(background).toBeGreaterThan(-1);
    expect(frame).toBeGreaterThan(background);
    expect(radar).toBeGreaterThan(frame);

    // The help line names the level control so nobody hunts for a third slider.
    const afterFrame = html.slice(frame, radar);
    expect(afterFrame).toMatch(
      /<div class="ird-supporting-text">\s*Background Volume sets the level of both\.\s*<\/div>/,
    );
  });

  it("setup-warning-patterns emits the two pattern fields", () => {
    const html = render("<%- include('setup-warning-patterns') %>", withRequire);

    expect(html).toContain('setting="setupWarningQualifyingPattern"');
    expect(html).toContain('setting="setupWarningRacePattern"');
    expect(html).not.toContain("<details");
  });
});
