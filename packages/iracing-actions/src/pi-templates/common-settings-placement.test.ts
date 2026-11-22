import { describe, expect, it } from "vitest";

import { actionPropertyInspectors, SURFACE_WRAPPERS, wrapperRange } from "./action-templates.test-support.js";

/**
 * `@iracedeck/pi-components`' `common-settings.ejs` carries the per-key Focus
 * iRacing window select (#1654), which applies on a key and on a dial alike.
 * On the 18 dial-capable PIs `#keypad-appearance` is hidden on the dial
 * surface, so an include left inside it would take the control away from every
 * dial user. What the partial renders is tested beside it in `pi-components`.
 */
const WITH_COMMON_SETTINGS = actionPropertyInspectors().filter(({ source }) => source.includes("common-settings"));

describe("common-settings.ejs in every action Property Inspector (#1654)", () => {
  it("finds them — 36 at the time of writing", () => {
    expect(WITH_COMMON_SETTINGS.length).toBeGreaterThanOrEqual(36);
  });

  it.each(WITH_COMMON_SETTINGS)("$name includes it exactly once", ({ source }) => {
    expect(source.match(/include\('common-settings'\)/g)).toHaveLength(1);
  });

  it.each(WITH_COMMON_SETTINGS)("$name keeps it outside every surface-conditional wrapper", ({ source }) => {
    const include = source.indexOf("include('common-settings')");

    for (const id of SURFACE_WRAPPERS) {
      const wrapper = wrapperRange(source, id);

      if (!wrapper) continue;

      expect({ id, inside: include > wrapper.start && include < wrapper.end }).toEqual({ id, inside: false });
    }
  });
});
