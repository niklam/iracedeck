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

describe("global-common-mouse-pointer.ejs (#1029)", () => {
  it.each(["mouseToSimAnchorX", "mouseToSimAnchorY", "mouseToSimOffsetX", "mouseToSimOffsetY"])("binds %s", (key) => {
    expect(partial).toContain(`setting="${key}"`);
  });

  it.each([...POINTER_ANCHORS_X, ...POINTER_ANCHORS_Y])("offers the %s anchor", (anchor) => {
    expect(partial).toContain(`value="${anchor}"`);
  });

  it("defaults both anchor selects to their schema default", () => {
    expect(partial).toContain(`setting="mouseToSimAnchorX" global default="${DEFAULT_POINTER_ANCHOR_X}"`);
    expect(partial).toContain(`setting="mouseToSimAnchorY" global default="${DEFAULT_POINTER_ANCHOR_Y}"`);
  });

  it("defaults both offset sliders to their schema default", () => {
    expect(partial).toContain(`setting="mouseToSimOffsetX" min="-${POINTER_OFFSET_LIMIT}"`);
    expect(partial).toContain(`setting="mouseToSimOffsetY" min="-${POINTER_OFFSET_LIMIT}"`);
    expect(partial).toContain(`default="${DEFAULT_POINTER_OFFSET_X}" global`);
    expect(partial).toContain(`default="${DEFAULT_POINTER_OFFSET_Y}" global`);
  });

  it("bounds both offset sliders by the offset limit", () => {
    const bounds = partial.match(/min="-?[\d.]+" max="-?[\d.]+"/g) ?? [];

    expect(bounds).toHaveLength(2);
    expect(new Set(bounds)).toEqual(new Set([`min="-${POINTER_OFFSET_LIMIT}" max="${POINTER_OFFSET_LIMIT}"`]));
  });

  it("saves all four controls globally", () => {
    expect(partial.match(/ global[ >]/g)).toHaveLength(4);
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
