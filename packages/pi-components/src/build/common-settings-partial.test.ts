import ejs from "ejs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `common-settings.ejs` (#1654) — the per-key Focus iRacing window select and
 * the keypad-only Flags Overlay item. Where every action template places it is
 * held by `iracing-actions`' `src/pi-templates/common-settings-placement.test.ts`.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

function render(): string {
  return ejs.render(
    "<%- include('common-settings') %>",
    {},
    { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
  );
}

describe("common-settings.ejs (#1654)", () => {
  it("renders the windowFocus select defaulting to the global setting", () => {
    expect(render()).toMatch(/<sdpi-select setting="windowFocus" default="global">/);
  });

  it("offers the three values in order", () => {
    const select = /<sdpi-select setting="windowFocus"[^>]*>([\s\S]*?)<\/sdpi-select>/.exec(render())?.[1] ?? "";

    expect([...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["global", "Use global setting"],
      ["focus", "Bring iRacing to the front"],
      ["no-focus", "Don't bring iRacing to the front"],
    ]);
  });

  it("marks Flags Overlay keypad-only and nothing else", () => {
    const html = render();

    expect(html).toMatch(/<sdpi-item label="Flags Overlay" data-keypad-only>/);
    expect(html.match(/data-keypad-only/g)).toHaveLength(1);
  });
});
