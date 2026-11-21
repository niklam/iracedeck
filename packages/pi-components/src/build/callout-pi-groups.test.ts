import * as registry from "@iracedeck/callout-settings";
import ejs from "ejs";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildCalloutPiGroups, loadCalloutPiGroups } from "./callout-pi-groups.mjs";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

const loaded = loadCalloutPiGroups();

describe("buildCalloutPiGroups (#1350)", () => {
  it("gives every heading its families' entries in order, on where the schema default is", () => {
    const groups = buildCalloutPiGroups(registry);
    const fuel = groups.find((g) => g.id === "fuel");

    expect(groups.map((g) => g.id)).toEqual(registry.CALLOUT_PI_GROUPS.map((g) => g.id));
    expect(fuel?.rows.slice(0, 2)).toEqual([
      { setting: "calloutEnabledFuelLapsLeft10", label: "10 laps of fuel left", on: false, feature: null },
      { setting: "calloutEnabledFuelLapsLeft9", label: "9 laps of fuel left", on: false, feature: null },
    ]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.setting))).toEqual([...registry.CALLOUT_SETTING_KEYS]);
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
      { calloutPiGroups: loaded.groups, ...locals },
      { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
    );
  const REJOIN = "calloutEnabledTrafficRejoin";
  const PIT_EXIT =
    '<sdpi-checkbox setting="calloutEnabledTrafficPitExit" label="Traffic at pit exit" global default="true"></sdpi-checkbox>';
  const RELEASE_FLAGS = { dialExtendedGestures: true, profiles: true, pngRasterization: true, trafficRejoin: false };

  it("marks the rejoin row with the trafficRejoin flag, and no other row with any", () => {
    const flagged = loaded.groups.flatMap((g) => g.rows.filter((r) => r.feature !== null));

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

describe("loadCalloutPiGroups (#1350)", () => {
  it("reads the built registry entry and lists every compiled file of it to watch", () => {
    expect(loaded.entryPath.split(path.sep).join("/")).toMatch(/\/callout-settings\/dist\/index\.js$/);
    expect(existsSync(loaded.entryPath)).toBe(true);
    expect(loaded.watchFiles).toContain(loaded.entryPath);
    expect(loaded.watchFiles).toContain(path.join(path.dirname(loaded.entryPath), "families", "flag.js"));
    expect(loaded.watchFiles).toContain(path.join(path.dirname(loaded.entryPath), "pi-groups.js"));
  });

  it("returns what the registry source says (a mismatch means the registry needs a rebuild)", () => {
    expect(loaded.groups).toEqual(buildCalloutPiGroups(registry));
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
