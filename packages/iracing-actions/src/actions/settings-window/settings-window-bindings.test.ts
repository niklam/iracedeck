import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Settings window's Key Bindings pane lists every binding in
 * `data/key-bindings.json` once per SETTING (#1277). A setting listed under two
 * categories — each for its own Property Inspector — keeps its row in the
 * category whose key prefixes the setting name, falling back to the first one
 * that lists it.
 *
 * The grouping is template code (the compile plugin's `require` resolves JSON
 * only, so it cannot live in an importable module). These tests run the REAL
 * block out of `settings-window.ejs`, from `var __rawBindings` through
 * `var __total`, against the real JSON and against small fixtures.
 */
const template = readFileSync(new URL("./settings-window.ejs", import.meta.url), "utf-8");
const realBindings = JSON.parse(readFileSync(new URL("../data/key-bindings.json", import.meta.url), "utf-8")) as Record<
  string,
  Row[]
>;

type Row = { id: string; label: string; default: string; setting: string };
type Grouping = { allBindings: Record<string, Row[]>; categories: string[]; total: number };

function groupingBlock(): string {
  const start = template.indexOf("var __rawBindings");
  const totalAt = template.indexOf("var __total", start);
  const end = template.indexOf("\n", totalAt);

  if (start < 0 || totalAt < 0) throw new Error("key-binding grouping block not found in settings-window.ejs");

  return template.slice(start, end);
}

function group(bindings: Record<string, Row[]>): Grouping {
  const run = new Function(
    "require",
    `${groupingBlock()}\nreturn { allBindings: __allBindings, categories: __categories, total: __total };`,
  ) as (require: (path: string) => unknown) => Grouping;

  return run((path) => {
    if (path !== "./data/key-bindings.json") throw new Error(`unexpected require: ${path}`);

    return bindings;
  });
}

const row = (setting: string): Row => ({ id: setting, label: setting, default: "", setting });

/** The categories that render a row for `setting`. */
function categoriesOf(grouping: Grouping, setting: string): string[] {
  return grouping.categories.filter((c) => grouping.allBindings[c].some((b) => b.setting === setting));
}

describe("settings-window key-binding grouping (#1277)", () => {
  const grouping = group(realBindings);

  it("keeps iRacing's Next / Previous Car under Replay Control, though Camera Controls lists them first", () => {
    expect(Object.keys(realBindings).indexOf("cameraControls")).toBeLessThan(
      Object.keys(realBindings).indexOf("replayControl"),
    );
    expect(categoriesOf(grouping, "replayControlNextCar")).toEqual(["replayControl"]);
    expect(categoriesOf(grouping, "replayControlPrevCar")).toEqual(["replayControl"]);
  });

  it("keeps the FFB force pair under Cockpit Misc, where it has always been", () => {
    expect(categoriesOf(grouping, "cockpitMiscFfbForceIncrease")).toEqual(["cockpitMisc"]);
    expect(categoriesOf(grouping, "cockpitMiscFfbForceDecrease")).toEqual(["cockpitMisc"]);
  });

  it("renders every setting exactly once and leaves no category empty", () => {
    const settings = grouping.categories.flatMap((c) => grouping.allBindings[c].map((b) => b.setting));
    const distinct = new Set(Object.values(realBindings).flatMap((rows) => rows.map((b) => b.setting)));

    expect(settings).toHaveLength(distinct.size);
    expect(new Set(settings)).toEqual(distinct);
    expect(grouping.total).toBe(distinct.size);

    for (const c of grouping.categories) {
      expect(grouping.allBindings[c].length, c).toBeGreaterThan(0);
    }
  });

  it("keeps the category order of key-bindings.json", () => {
    expect(grouping.categories).toEqual(Object.keys(realBindings));
  });

  it("falls back to the first listing category when none prefixes the setting", () => {
    const result = group({ alpha: [row("sharedKey")], beta: [row("sharedKey"), row("betaOwn")] });

    expect(categoriesOf(result, "sharedKey")).toEqual(["alpha"]);
    expect(result.total).toBe(2);
  });

  it("prefers the longest prefixing category when several prefix the setting", () => {
    const result = group({
      setup: [row("setupFuelMix"), row("setupOther")],
      setupFuel: [row("setupFuelMix")],
    });

    expect(categoriesOf(result, "setupFuelMix")).toEqual(["setupFuel"]);
  });
});
