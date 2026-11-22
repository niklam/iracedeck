import * as registry from "@iracedeck/callout-settings";
import ejs from "ejs";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildCalloutPiSections, loadCalloutPiSections } from "./callout-pi-groups.mjs";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

const loaded = loadCalloutPiSections();

describe("buildCalloutPiSections (#1350, #1700)", () => {
  const sections = buildCalloutPiSections(registry);
  const headings = sections.flatMap((s) => s.groups);

  it("gives the sections and their headings in registry order, each heading with its description", () => {
    expect(sections.map((s) => [s.id, s.title])).toEqual(registry.CALLOUT_PI_SECTIONS.map((s) => [s.id, s.title]));

    for (const [i, section] of registry.CALLOUT_PI_SECTIONS.entries()) {
      expect(
        sections[i]!.groups.map((g) => [g.id, g.title, g.description]),
        section.id,
      ).toEqual(section.groups.map((g) => [g.id, g.title, g.description]));
    }

    expect(headings.map((g) => g.id)).toEqual(registry.CALLOUT_PI_GROUPS.map((g) => g.id));
  });

  it("gives every heading its families' entries in order, on where the schema default is", () => {
    const fuel = headings.find((g) => g.id === "fuel");

    expect(fuel?.rows.slice(0, 2)).toEqual([
      {
        setting: "calloutEnabledFuelLapsLeft10",
        label: "10 laps of fuel left",
        description: null,
        on: false,
        feature: null,
      },
      {
        setting: "calloutEnabledFuelLapsLeft9",
        label: "9 laps of fuel left",
        description: null,
        on: false,
        feature: null,
      },
    ]);
  });

  it("flattens to exactly the registry's keys, in order", () => {
    expect(headings.flatMap((g) => g.rows.map((r) => r.setting))).toEqual([...registry.CALLOUT_SETTING_KEYS]);
  });

  it("carries each entry's description, and null where it has none", () => {
    const entries = registry.CALLOUT_PI_GROUPS.flatMap((g) =>
      g.families.flatMap((f) => Object.values(f.callouts) as { key: string; description?: string }[]),
    );
    const rows = new Map(headings.flatMap((g) => g.rows).map((r) => [r.setting, r]));

    for (const entry of entries) expect(rows.get(entry.key)?.description, entry.key).toBe(entry.description ?? null);
  });

  it("passes a fixture registry through as it stands: description, feature and the default as given", () => {
    const fixture = {
      CALLOUT_PI_SECTIONS: [
        {
          id: "s",
          title: "S",
          groups: [
            {
              id: "g",
              title: "G",
              description: "Heading text.",
              families: [
                {
                  id: "f",
                  callouts: {
                    a: { key: "calloutEnabledA", label: "A", description: "Entry text." },
                    b: { key: "calloutEnabledB", label: "B", requiresFeature: "flag" },
                  },
                },
              ],
            },
          ],
        },
      ],
      calloutDefault: (key: string) => key === "calloutEnabledA",
    } as unknown as Parameters<typeof buildCalloutPiSections>[0];

    expect(buildCalloutPiSections(fixture)).toEqual([
      {
        id: "s",
        title: "S",
        groups: [
          {
            id: "g",
            title: "G",
            description: "Heading text.",
            rows: [
              { setting: "calloutEnabledA", label: "A", description: "Entry text.", on: true, feature: null },
              { setting: "calloutEnabledB", label: "B", description: null, on: false, feature: "flag" },
            ],
          },
        ],
      },
    ]);
  });
});

describe("the Traffic checkboxes as the settings window renders them (#1113)", () => {
  // The settings window's Callouts card is the one surface that renders the
  // callout checkboxes (the partial below, included by `iracing-actions`'
  // `settings-window.ejs` on every platform); its rows come from the built
  // registry, so this renders what the plugins ship. The rejoin warnings do
  // not ship (the spec's fourth amendment, 2026-11-21): their checkbox renders
  // only in a build with the `trafficRejoin` development flag on, where it is
  // labelled experimental and unticked (2026-11-20) — an OFF default omits
  // `default` entirely, since `default="false"` renders checked.
  const partialsDir = path.resolve(import.meta.dirname, "../../partials");
  const render = (locals: Record<string, unknown>): string =>
    ejs.render(
      "<%- include('race-engineer-callouts') %>",
      { calloutPiSections: loaded.sections, ...locals },
      { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
    );
  const REJOIN = "calloutEnabledTrafficRejoin";
  const PIT_EXIT =
    '<sdpi-checkbox setting="calloutEnabledTrafficPitExit" label="Traffic at pit exit" global default="true"></sdpi-checkbox>';
  const RELEASE_FLAGS = { dialExtendedGestures: true, profiles: true, pngRasterization: true, trafficRejoin: false };

  it("marks the rejoin row with the trafficRejoin flag, and no other row with any", () => {
    const flagged = loaded.sections.flatMap((s) => s.groups.flatMap((g) => g.rows.filter((r) => r.feature !== null)));

    expect(flagged.map((r) => [r.setting, r.feature])).toEqual([[REJOIN, "trafficRejoin"]]);
  });

  it.each([
    ["a release build's flags", { platform: { features: RELEASE_FLAGS } }],
    ["no platform at all", {}],
    ["flags without trafficRejoin", { platform: { features: { profiles: true } } }],
  ])("leaves the rejoin checkbox out with %s, and keeps the pit-exit one ticked", (_, locals) => {
    const html = render(locals);

    expect(html).not.toContain(REJOIN);
    expect(html).not.toContain("Traffic when rejoining");
    expect(html).toContain(PIT_EXIT);
  });

  it("renders the rejoin checkbox, labelled experimental and unticked, with the flag on (a development build)", () => {
    const html = render({ platform: { features: { ...RELEASE_FLAGS, trafficRejoin: true } } });

    expect(html).toContain(
      `<sdpi-checkbox setting="${REJOIN}" label="Traffic when rejoining (experimental)" global></sdpi-checkbox>`,
    );
    expect(html).toContain(PIT_EXIT);
  });
});

describe("loadCalloutPiSections (#1350, #1700)", () => {
  it("reads the built registry entry and lists every compiled file of it to watch", () => {
    expect(loaded.entryPath.split(path.sep).join("/")).toMatch(/\/callout-settings\/dist\/index\.js$/);
    expect(existsSync(loaded.entryPath)).toBe(true);
    expect(loaded.watchFiles).toContain(loaded.entryPath);
    expect(loaded.watchFiles).toContain(path.join(path.dirname(loaded.entryPath), "families", "flag.js"));
    expect(loaded.watchFiles).toContain(path.join(path.dirname(loaded.entryPath), "pi-groups.js"));
  });

  it("returns what the registry source says (a mismatch means the registry needs a rebuild)", () => {
    expect(loaded.sections).toEqual(buildCalloutPiSections(registry));
  });
});

describe("piTemplatePlugin watches the registry (#1350)", () => {
  it("adds every compiled registry file to the watch list at the start of a build", () => {
    const plugin = piTemplatePlugin({
      templatesDir: path.join(import.meta.dirname, "no-such-templates"),
      outputDir: path.join(import.meta.dirname, "no-such-output"),
      partialsDir: path.join(import.meta.dirname, "no-such-partials"),
      version: "1.0.0",
    });
    const context = { addWatchFile: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    plugin.buildStart.call(context);

    for (const file of loaded.watchFiles) expect(context.addWatchFile).toHaveBeenCalledWith(file);
  });
});
