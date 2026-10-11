import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readSupportPartialConstants } from "../packages/pi-components/src/build/support-partial-constants.ts";
import {
  MEMBERSHIP_URL,
  SUPPORT_BUTTON_IMAGE_HEIGHT,
  SUPPORT_BUTTON_IMAGE_URL,
  SUPPORT_BUTTON_IMAGE_WIDTH,
  SUPPORT_URL,
} from "../packages/website/src/data/support.ts";

/**
 * The website's support links vs. the Settings window's (#1299, #1303).
 *
 * The same Buy Me a Coffee button and membership link are on the website
 * (`SupportSection.astro`, from `packages/website/src/data/support.ts`) and on
 * the plugin's Support iRaceDeck tab (`settings-window-support.ejs`). The
 * website imports nothing from the plugin and a Property Inspector partial can
 * import nothing at all, so each side holds its own copy, and nothing but this
 * test notices when one of them moves: a changed slug on the site would leave
 * the plugin sending its users to the old page, with every other test green.
 *
 * The plugin side is read as text, through the one reader every test of that
 * partial uses. The image URL is compared too, though the window loads it and
 * the test that allow-lists it (`settings-window-no-third-party.test.ts`) pins
 * the partial's copy: this is the link between that copy and the site's.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const partialSource = readFileSync(
  join(repoRoot, "packages", "pi-components", "partials", "settings-window-support.ejs"),
  "utf-8",
);
const partial = readSupportPartialConstants(partialSource, [
  "SUPPORT_URL",
  "MEMBERSHIP_URL",
  "SUPPORT_BUTTON_IMAGE_URL",
]);

describe("the support links on the website and in the Settings window", () => {
  it("send the button to the same page", () => {
    expect(partial.SUPPORT_URL).toBe(SUPPORT_URL);
  });

  it("send the Supporter link to the same membership page", () => {
    expect(partial.MEMBERSHIP_URL).toBe(MEMBERSHIP_URL);
  });

  it("draw the same button image", () => {
    expect(partial.SUPPORT_BUTTON_IMAGE_URL).toBe(SUPPORT_BUTTON_IMAGE_URL);
  });

  it("reserve the same box for it", () => {
    // The width follows the image URL's `text` parameter, so a change to the
    // button's text on one side is a change to this number on both.
    const image = /<img\b[^>]*\bsrc="<%= SUPPORT_BUTTON_IMAGE_URL %>"[^>]*>/.exec(partialSource)?.[0] ?? "";

    expect(image, "the partial no longer draws the button with <%= SUPPORT_BUTTON_IMAGE_URL %>").not.toBe("");
    expect(image).toContain(`width="${SUPPORT_BUTTON_IMAGE_WIDTH}"`);
    expect(image).toContain(`height="${SUPPORT_BUTTON_IMAGE_HEIGHT}"`);
  });
});
