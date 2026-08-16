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
 * Renders the REAL global-common-settings.ejs. Its seven groups are being split
 * into per-group partials (#992) so the settings window can place them on
 * separate tabs while the PI keeps assembling them into one accordion — this
 * pins every setting key so the split can't silently drop a control.
 */
const COMMON_SETTING_KEYS = [
  "focusIRacingWindow",
  "disableWhenDisconnected",
  "simHubHost",
  "simHubPort",
  "dualPressThresholdMs",
  "dualPressDirections",
  "fastestLapSearchDelayMs",
  "chatOpenToPasteDelayMs",
  "chatPasteToEnterDelayMs",
  "chatEnterToCloseDelayMs",
  "changelogNotification",
  "debugLogging",
];

describe("global-common-settings.ejs", () => {
  it("still exposes every common setting inside one accordion in PI mode", () => {
    // The nested profiles accordion `require()`s build-time data the real
    // template plugin provides; gate it off here exactly as the Mirabox/Ulanzi
    // builds do, since this test is about the common-settings groups.
    const html = render("<%- include('global-common-settings') %>", { platform: { features: { profiles: false } } });

    expect(html).toContain('data-accordion-id="Global Common Settings"');
    for (const key of COMMON_SETTING_KEYS) expect(html, key).toContain(`setting="${key}"`);
  });

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

  it("race-engineer-settings emits the voice, name, device, volume and on-startup controls", () => {
    const html = render("<%- include('race-engineer-settings') %>", withRequire);

    for (const key of [
      "pitCrewRaceEngineerEnabledOnStartup",
      "pitCrewRadarEnabledOnStartup",
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
