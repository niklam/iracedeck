import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
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
      "global-common-window-focus": ["focusIRacingWindow", "disableWhenDisconnected"],
      "global-common-simhub": ["simHubHost", "simHubPort"],
      "global-common-dual-press": ["dualPressThresholdMs", "dualPressDirections"],
      "global-common-replay": ["fastestLapSearchDelayMs"],
      "global-common-chat": ["chatOpenToPasteDelayMs", "chatPasteToEnterDelayMs", "chatEnterToCloseDelayMs"],
      "global-common-updates": ["changelogNotification"],
      "global-common-diagnostics": ["debugLogging"],
    };

    for (const [partial, keys] of Object.entries(groups)) {
      const html = render(`<%- include('${partial}') %>`);

      expect(html, partial).not.toContain("<details");
      for (const key of keys) expect(html, `${partial} → ${key}`).toContain(`setting="${key}"`);
    }
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
});

/**
 * The Race Engineer / Pit Crew plugin-wide settings used to be authored
 * inline in pit-crew.ejs. They are now three partials (#992) so the settings
 * window can show them on a Race Engineer tab while pit-crew.ejs keeps its
 * three accordions. Pin representative keys per partial so neither surface
 * can silently lose a control.
 */
describe("race-engineer partials", () => {
  // The templates `require()` shared data (callout ids etc.); the real build
  // resolves that from iracing-actions' data dir — point the test there.
  const dataRequire = (spec: string): unknown => {
    const rel = spec.replace(/^\.\//, "");
    const file = path.resolve(partialsDir, "../../iracing-actions/src/actions", rel);

    return JSON.parse(readFileSync(file, "utf-8"));
  };
  const withRequire = { require: dataRequire };

  it("race-engineer-settings emits the live toggles, startup policies, voice, name, device and volumes", () => {
    const html = render("<%- include('race-engineer-settings') %>", withRequire);

    for (const key of [
      "pitCrewRaceEngineerEnabled",
      "pitCrewRaceEngineerStartupPolicy",
      "pitCrewRadarEnabled",
      "pitCrewRadarStartupPolicy",
      "raceEngineerVoice",
      "driverName",
      "audioOutputDevice",
    ]) {
      expect(html, key).toContain(`setting="${key}"`);
    }
    expect(html).not.toContain("<details");
  });

  it("race-engineer-callouts emits the per-callout opt-ins", () => {
    const html = render("<%- include('race-engineer-callouts') %>", withRequire);

    expect(html).toContain('setting="calloutEnabledFlag');
    expect((html.match(/setting="calloutEnabled/g) ?? []).length).toBeGreaterThan(40);
    expect(html).not.toContain("<details");
  });

  it("setup-warning-patterns emits the two pattern fields", () => {
    const html = render("<%- include('setup-warning-patterns') %>", withRequire);

    expect(html).toContain('setting="setupWarningQualifyingPattern"');
    expect(html).toContain('setting="setupWarningRacePattern"');
    expect(html).not.toContain("<details");
  });
});
