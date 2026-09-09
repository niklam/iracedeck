// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { DEFAULT_FOCUS_IRACING_MODE, FOCUS_IRACING_MODES } from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

import { ENABLE_FEATURE_COPY } from "../components/enable-feature.js";

/**
 * The three Focus iRacing modes (#977) are declared once in deck-core
 * (`focus-iracing-mode.ts`, which the settings schema and the window-focus
 * service both import) and then written out by hand in two places that cannot
 * import it: the General tab's `<sdpi-select>`, which is markup in an `.ejs`
 * file neither prettier nor eslint reads, and the Getting Started control's
 * copy table, which ships in a browser bundle that must not pull deck-core in.
 *
 * Both drift SILENTLY. An option value the schema does not accept is stored,
 * folded back to `always` by `parseFocusIRacingMode`, and shown as whatever the
 * select happens to render — a setting that appears to save and does not. A
 * `default` that disagrees with the schema pre-selects a mode the plugin is not
 * running in. And an `isOn` that misses a mode puts the Getting Started page's
 * "Turn on Focus iRacing Window" offer in front of somebody who already has it
 * on, or withholds it from somebody who does not. Nothing else connects any of
 * these to the constants, so they are pinned here.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const partial = readFileSync(path.join(partialsDir, "global-common-window-focus.ejs"), "utf-8");

/**
 * The select's own block, not the whole partial: the file also carries the
 * Connection checkbox with a `default` of its own, so an unscoped `toContain`
 * would pass on the wrong control's attribute.
 */
const select = /<sdpi-select[^>]*setting="focusIRacingWindow"[\s\S]*?<\/sdpi-select>/.exec(partial)?.[0] ?? "";

describe("global-common-window-focus.ejs (#977)", () => {
  it("still binds a select to the focus setting", () => {
    // Guards every assertion below: a renamed setting would otherwise leave
    // them all reading an empty string and passing vacuously.
    expect(select).not.toBe("");
  });

  it("offers exactly the modes the schema accepts, in their declared order", () => {
    const offered = [...select.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);

    expect(offered).toEqual([...FOCUS_IRACING_MODES]);
  });

  it("pre-selects the mode the schema actually defaults to", () => {
    expect(select).toContain(`default="${DEFAULT_FOCUS_IRACING_MODE}"`);
  });
});

describe("Getting Started focus opt-in (#977, #1061)", () => {
  const copy = ENABLE_FEATURE_COPY["focus-iracing-window"];

  it("is a feature the control knows about", () => {
    expect(copy).toBeDefined();
  });

  // `required` is on, just narrower — only `never` is off, so only `never`
  // gets the offer. Driven off deck-core's list rather than a local literal,
  // so a fourth mode fails here until `isOn` has an answer for it.
  it.each([...FOCUS_IRACING_MODES])("reads %s as on unless it is never", (mode) => {
    expect(copy.isOn(mode)).toBe(mode !== "never");
  });
});
