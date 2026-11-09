import * as iconComposer from "@iracedeck/icon-composer";
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as overlayUtils from "./overlay-utils.js";

describe("overlay-utils", () => {
  it("re-exports exactly icon-composer's SVG data-URI helpers", () => {
    expect(Object.keys(overlayUtils).sort()).toEqual(["dataUriToSvg", "isDataUri", "isRawSvg", "svgToDataUri"]);

    for (const name of Object.keys(overlayUtils) as Array<keyof typeof overlayUtils>) {
      expect(overlayUtils[name], name).toBe(iconComposer[name]);
    }
  });

  it("leaves the deleted inactive overlay and hexToGrayscale out of the deck-core barrel (#1599)", () => {
    for (const name of ["applyInactiveOverlay", "overlayConfig", "hexToGrayscale"]) {
      expect(name in barrel, name).toBe(false);
    }
  });
});
