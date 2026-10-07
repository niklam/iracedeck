import * as registry from "@iracedeck/callout-settings";
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
      { setting: "calloutEnabledFuelLapsLeft10", label: "10 laps of fuel left", on: false },
      { setting: "calloutEnabledFuelLapsLeft9", label: "9 laps of fuel left", on: false },
    ]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.setting))).toEqual([...registry.CALLOUT_SETTING_KEYS]);
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
