import ejs from "ejs";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * `@iracedeck/pi-components/testing`: test support for the packages whose pages
 * include this package's partials (#1375). The action Property Inspector
 * templates and the settings window's page live in `@iracedeck/iracing-actions`,
 * so the tests that hold those pages to the partials live there too, and reach
 * what they need from here by package name. Never imported by a build.
 *
 * The partials directory and the EJS compile plugin are on `./build`, where the
 * plugin build already takes them; this entry adds what only a test needs.
 */

export { findThirdPartyReferences, type ThirdPartyReference } from "./third-party-references.js";

const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

/**
 * Renders the REAL `partials/<name>.ejs` with `locals`, the way an including
 * page renders it, other partials resolved from the same directory. A partial
 * that reads build data (`require('./data/profiles.json')`) takes a `require`
 * local standing in for the compile plugin's.
 */
export function renderPartial(name: string, locals: Record<string, unknown> = {}): string {
  const file = path.join(partialsDir, `${name}.ejs`);

  return ejs.render(readFileSync(file, "utf-8"), locals, { filename: file, views: [partialsDir] });
}

/**
 * Every image the Settings window may load from another site (#1303). Adding
 * one is a decision about what a third party learns each time a user opens
 * that part of the window, so it is made here, in review, and not by a
 * template. `settings-window-no-third-party.test.ts` holds the partials and
 * the built pages to it, and `iracing-actions` holds the window's page.
 */
export const SETTINGS_WINDOW_REMOTE_IMAGES: readonly string[] = [
  // Buy Me a Coffee's button on the Support iRaceDeck tab (#1303): an SVG drawn
  // by an <img>, which runs no script and follows no link.
  "https://img.buymeacoffee.com/button-api/?text=Support%20iRaceDeck&emoji=%F0%9F%8F%8E%EF%B8%8F&slug=niklaslampen&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff",
];
