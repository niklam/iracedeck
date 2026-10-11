import { SETTINGS_WINDOW_HTML } from "@iracedeck/app-constants";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { discoverPlugins } from "../../../../scripts/lib/plugin-config-shape.mjs";
import { readSupportPartialConstants } from "./support-partial-constants.js";
import { findThirdPartyReferences, type ThirdPartyReference } from "./third-party-references.js";

/**
 * The Settings window runs no code from another site (#1303).
 *
 * The page holds a write connection to the user's settings. Until the Support
 * iRaceDeck tab nothing in it came from a third party, by habit; that tab
 * hotlinks one image, so the line is written down here: no `<script>`,
 * stylesheet, font, frame or media element names another origin, no inline
 * script holds another origin's address, an image may name one only when it is
 * on the allow-list below, and an anchor is the only other element that may
 * carry an absolute URL.
 *
 * Held in two places. The SOURCES (the page and every partial, since any
 * partial can be included by it) always run. The BUILT pages are what actually
 * ships, and also cover whatever a build step injects: they run wherever a
 * build is present, and must be present in CI.
 *
 * A scan that finds nothing proves something only if the scanner would have
 * found it. `third-party-references.test.ts` is that positive control, and the
 * scanner's header says what it does not read.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const repoRoot = path.resolve(partialsDir, "../../..");
const windowPage = path.join(repoRoot, "packages/iracing-actions/src/actions/settings-window/settings-window.ejs");

/**
 * Every image the window may load from another site. Adding one is a decision
 * about what a third party learns each time a user opens that part of the
 * window, so it is made here, in review, and not by a template.
 */
const ALLOWED_REMOTE_IMAGES = [
  // Buy Me a Coffee's button on the Support iRaceDeck tab (#1303): an SVG drawn
  // by an <img>, which runs no script and follows no link.
  "https://img.buymeacoffee.com/button-api/?text=Support%20iRaceDeck&emoji=%F0%9F%8F%8E%EF%B8%8F&slug=niklaslampen&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff",
];

/** The one partial that names an allowed image, and the constant it names it by. */
const SUPPORT_PARTIAL = "settings-window-support.ejs";
const IMAGE_CONSTANT = "SUPPORT_BUTTON_IMAGE_URL";

const partials = readdirSync(partialsDir)
  .filter((name) => name.endsWith(".ejs"))
  .sort();

/** One line per finding, so a failure names the element and the value. */
function lines(found: ThirdPartyReference[]): string[] {
  return found.map(({ where, value, why }) => `${where} ${value} (${why})`);
}

describe("the Settings window's sources", () => {
  const supportSource = readFileSync(path.join(partialsDir, SUPPORT_PARTIAL), "utf-8");

  it("finds the partials at all", () => {
    // Guards the scan below against an empty directory read passing it vacuously.
    expect(partials.length).toBeGreaterThanOrEqual(30);
    expect(partials).toContain(SUPPORT_PARTIAL);
    expect(partials).toContain("head-common.ejs");
  });

  it("names the support button's image by a constant that is on the allow-list", () => {
    // What licenses reading `<%= SUPPORT_BUTTON_IMAGE_URL %>` as an allowed
    // image in that partial's source: the expression is this one literal. The
    // reader throws unless the constant is declared exactly once.
    const declared = readSupportPartialConstants(supportSource, [IMAGE_CONSTANT]);

    expect(supportSource.split(IMAGE_CONSTANT)).toHaveLength(3);
    expect(ALLOWED_REMOTE_IMAGES).toContain(declared[IMAGE_CONSTANT]);
  });

  it("sees that image, so the exemption is doing something", () => {
    expect(lines(findThirdPartyReferences(supportSource, { allowedImages: ALLOWED_REMOTE_IMAGES }))).toEqual([
      `<img src> {{ejs:<%= ${IMAGE_CONSTANT} %>}} (unresolved)`,
    ]);
  });

  it("names no other origin in the page", () => {
    const found = findThirdPartyReferences(readFileSync(windowPage, "utf-8"), { allowedImages: ALLOWED_REMOTE_IMAGES });

    expect(lines(found)).toEqual([]);
  });

  it.each(partials)("names no other origin in %s", (name) => {
    const found = findThirdPartyReferences(readFileSync(path.join(partialsDir, name), "utf-8"), {
      allowedImages: ALLOWED_REMOTE_IMAGES,
      // An EJS expression is exempt in the one file that declares it, where the
      // test above has read its value. Anywhere else it is an unknown.
      allowedImageExpressions: name === SUPPORT_PARTIAL ? [IMAGE_CONSTANT] : [],
    });

    expect(lines(found)).toEqual([]);
  });
});

describe("the built Settings window pages", () => {
  const plugins = discoverPlugins(repoRoot);

  it("finds every plugin", () => {
    expect(plugins.length, "fewer plugins than deck ecosystems: discovery broke").toBeGreaterThanOrEqual(3);
  });

  describe.each(plugins)("$pkg", ({ pkg, folder }) => {
    const builtPage = path.join(repoRoot, "packages", pkg, folder, "ui", SETTINGS_WINDOW_HTML);

    it("loads nothing from another site but the allow-listed image", () => {
      if (!existsSync(builtPage)) {
        // CI builds before it tests (`ci-test.yml`), so a page missing there is
        // a moved path or a broken discovery, and passing would hide it.
        // Anywhere else the plugin has not been built in this checkout; the
        // source scan above still ran.
        expect(
          process.env.CI,
          `${builtPage} is missing, and CI builds before it tests: the page moved, or plugin discovery broke`,
        ).toBeFalsy();

        return;
      }

      const html = readFileSync(builtPage, "utf-8");

      expect(lines(findThirdPartyReferences(html, { allowedImages: ALLOWED_REMOTE_IMAGES }))).toEqual([]);
      // …and with nothing allowed the same scan reports exactly the allowed
      // images, which is what shows it read the page that carries them. The
      // page writes each URL's `&` as an entity.
      expect(
        lines(findThirdPartyReferences(html)).sort(),
        `the page at ${builtPage} does not carry the Support tab's button, so it was built before #1303 — ` +
          "rebuild with `pnpm build`",
      ).toEqual(ALLOWED_REMOTE_IMAGES.map((image) => `<img src> ${image.replaceAll("&", "&amp;")} (remote)`).sort());
    });
  });
});
