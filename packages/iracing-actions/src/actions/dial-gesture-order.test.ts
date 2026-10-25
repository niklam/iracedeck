import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every dial gesture dropdown lists None first, then Mode default where it
 * has one, then the rest in one order per action (#1448). A default comes from
 * the `default` attribute and the schema, never from option position, so this
 * only pins the order the user sees.
 */

const ACTIONS_DIR = import.meta.dirname;

interface GestureSelect {
  template: string;
  setting: string;
  values: string[];
}

function gestureSelects(): GestureSelect[] {
  const found: GestureSelect[] = [];

  for (const dir of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    for (const file of readdirSync(join(ACTIONS_DIR, dir.name)).filter((f) => f.endsWith(".ejs"))) {
      const text = readFileSync(join(ACTIONS_DIR, dir.name, file), "utf8");
      const pattern = /<sdpi-select\b[^>]*\bsetting="(dial\.\w+Action)"[^>]*>([\s\S]*?)<\/sdpi-select>/g;

      for (const m of text.matchAll(pattern)) {
        found.push({
          template: `${dir.name}/${file}`,
          setting: m[1],
          values: [...m[2].matchAll(/<option\b[^>]*\bvalue="([^"]+)"/g)].map((o) => o[1]),
        });
      }
    }
  }

  return found;
}

const SURVEYED = [
  "audio-controls",
  "black-box-selector",
  "camera-editor-adjustments",
  "camera-focus",
  "cockpit-misc",
  "force-feedback",
  "fuel-service",
  "replay-control",
  "replay-markers",
  "setup-aero",
  "setup-brakes",
  "setup-chassis",
  "setup-fuel",
  "setup-traction",
  "splits-delta-cycle",
  "view-adjustment",
];

const selects = gestureSelects();
const named = (list: GestureSelect[]) => list.map((s) => [`${s.template} ${s.setting}`, s] as const);

describe("dial gesture dropdown order (#1448)", () => {
  it.each(SURVEYED)("finds the gesture dropdowns of %s", (action) => {
    expect(selects.filter((s) => s.template.startsWith(`${action}/`)).length).toBeGreaterThan(0);
  });

  it.each(named(selects))("%s lists None first", (_name, s) => {
    expect(s.values[0], `${s.template} ${s.setting}: ${s.values.join(",")}`).toBe("none");
  });

  it.each(named(selects.filter((s) => s.values.includes("mode-default"))))(
    "%s lists Mode default second",
    (_name, s) => {
      expect(s.values[1], `${s.template} ${s.setting}: ${s.values.join(",")}`).toBe("mode-default");
    },
  );

  it("lists the rest in one order across the dropdowns of a template that offer the same set", () => {
    const groups = new Map<string, GestureSelect>();

    for (const s of selects) {
      const key = `${s.template}|${[...s.values].sort().join(",")}`;
      const first = groups.get(key);

      if (!first) groups.set(key, s);
      else expect(s.values, `${s.template}: ${s.setting} differs from ${first.setting}`).toEqual(first.values);
    }
  });
});
