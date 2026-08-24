import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  POINTER_ANCHORS_X,
  POINTER_ANCHORS_Y,
  POINTER_OFFSET_LIMIT,
} from "./sim-pointer-target.js";

/**
 * The settings window's controls carry their own `default="…"` attributes, so a
 * default changed on one side of the pair and not the other would show the user
 * one value and apply another. `@iracedeck/pi-components` is dependency-free on
 * purpose and must not gain a dependency on deck-core for a test, so the guard
 * lives on this side — reading a sibling package's file by relative path, the
 * same way `pi-components/src/build` reads `iracing-actions`.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");
const partial = readFileSync(
  path.join(repoRoot, "packages/pi-components/partials/global-common-mouse-pointer.ejs"),
  "utf-8",
);
const settingsWindow = readFileSync(
  path.join(repoRoot, "packages/iracing-actions/src/actions/settings-window/settings-window.ejs"),
  "utf-8",
);

/** Every setting the card binds, in the order it lists them. */
const SETTING_KEYS = ["mouseToSimAnchorX", "mouseToSimOffsetX", "mouseToSimAnchorY", "mouseToSimOffsetY"] as const;

/**
 * The one opening tag bound to `setting`.
 *
 * Attributes are read off THIS tag rather than matched against the whole file:
 * a bare `toContain('default="0" global')` passes on any control that happens to
 * carry it, and one that spells out an attribute SEQUENCE fails on a harmless
 * reformat while proving nothing extra.
 */
function control(setting: string): string {
  const match = partial.match(new RegExp(`<[a-z-]+[^>]*\\bsetting="${setting}"[^>]*>`));

  expect(match, `no control bound to ${setting}`).not.toBeNull();

  return match![0];
}

/** One attribute of a control tag, or `undefined` when it carries none. */
function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("global-common-mouse-pointer.ejs (#1029)", () => {
  it.each(SETTING_KEYS)("binds %s", (key) => {
    expect(partial).toContain(`setting="${key}"`);
  });

  it.each([...POINTER_ANCHORS_X, ...POINTER_ANCHORS_Y])("offers the %s anchor", (anchor) => {
    expect(partial).toContain(`value="${anchor}"`);
  });

  it("defaults both anchor selects to their schema default", () => {
    expect(attr(control("mouseToSimAnchorX"), "default")).toBe(DEFAULT_POINTER_ANCHOR_X);
    expect(attr(control("mouseToSimAnchorY"), "default")).toBe(DEFAULT_POINTER_ANCHOR_Y);
  });

  it("defaults both offset sliders to their schema default", () => {
    expect(attr(control("mouseToSimOffsetX"), "default")).toBe(String(DEFAULT_POINTER_OFFSET_X));
    expect(attr(control("mouseToSimOffsetY"), "default")).toBe(String(DEFAULT_POINTER_OFFSET_Y));
  });

  it("bounds both offset sliders by the offset limit", () => {
    for (const setting of ["mouseToSimOffsetX", "mouseToSimOffsetY"]) {
      const tag = control(setting);

      expect(attr(tag, "min")).toBe(String(-POINTER_OFFSET_LIMIT));
      expect(attr(tag, "max")).toBe(String(POINTER_OFFSET_LIMIT));
    }
  });

  it.each(SETTING_KEYS)("saves %s globally", (key) => {
    expect(control(key)).toMatch(/\sglobal[\s>]/);
  });

  it("uses only sdpi/ird components, never raw form controls", () => {
    expect(partial).not.toMatch(/<(input|select|button|textarea)[\s>]/);
  });

  it("emits items only, so the includer supplies the heading", () => {
    expect(partial).not.toContain("include('accordion'");
  });

  it("is rendered by the settings window", () => {
    expect(settingsWindow).toContain("include('global-common-mouse-pointer')");
  });
});
