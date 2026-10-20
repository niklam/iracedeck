import ejs from "ejs";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/global-stream-deck-profiles.ejs` (#736, #992,
 * #1457). In the settings window each template row carries the device types it
 * ships for, read from `profiles.json` at build time, so `ird-profile-variants`
 * can hide a row the chosen deck has no variant of and show the note when it
 * has none. The Property Inspector rendering has no deck picker and must not
 * change.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const templatePath = path.join(partialsDir, "global-stream-deck-profiles.ejs");
const realProfiles = JSON.parse(
  readFileSync(path.resolve(partialsDir, "../../iracing-actions/src/actions/data/profiles.json"), "utf-8"),
) as ProfileRow[];

type ProfileRow = { name: string; deviceType?: number; displayName?: string };

function render(locals: Record<string, unknown>, profiles: ProfileRow[] = realProfiles): string {
  const require = (spec: string): unknown => {
    if (spec !== "./data/profiles.json") throw new Error(`unexpected require: ${spec}`);

    return profiles;
  };

  return ejs.render(readFileSync(templatePath, "utf-8"), { require, ...locals }, { filename: templatePath });
}

const fixture: ProfileRow[] = [
  { name: "iRaceDeck Default XL", deviceType: 2, displayName: "iRaceDeck Default" },
  { name: "iRaceDeck Default SD", deviceType: 0, displayName: "iRaceDeck Default" },
  { name: "iRaceDeck Replay XL", deviceType: 2, displayName: "iRaceDeck Replay" },
  { name: "iRaceDeck Replay Plus XL", deviceType: 13, displayName: "iRaceDeck Replay" },
];

/** The `data-device-types` each row carries, keyed by its label. */
function rowTypes(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/<sdpi-item label="([^"]+)" data-device-types="([^"]*)">/g)].map((m) => [m[1], m[2]]),
  );
}

describe("global-stream-deck-profiles.ejs in the settings window (#1457)", () => {
  it("gives each template row the device types it has a variant for, one row per template", () => {
    const html = render({ settingsWindow: true }, fixture);

    expect(rowTypes(html)).toEqual({ "iRaceDeck Default": "2,0", "iRaceDeck Replay": "2,13" });
  });

  it("puts every real template's row inside ird-profile-variants, bound to the deck picker", () => {
    const html = render({ settingsWindow: true });
    const wrapper = /<ird-profile-variants device-from="sw-deck-device">([\s\S]*?)<\/ird-profile-variants>/.exec(html);
    const templates = [...new Set(realProfiles.map((p) => p.displayName ?? p.name))];

    expect(html).toContain('<ird-deck-device-select select-id="sw-deck-device">');
    expect(wrapper).not.toBeNull();
    expect(Object.keys(rowTypes(wrapper![1]))).toEqual(templates);

    for (const name of templates) {
      const types = realProfiles.filter((p) => (p.displayName ?? p.name) === name).map((p) => p.deviceType);

      expect(rowTypes(html)[name]!.split(",").map(Number).sort(), name).toEqual([...new Set(types)].sort());
    }
  });

  it("carries the no-profiles note, hidden until a deck without variants is chosen", () => {
    const html = render({ settingsWindow: true });

    expect(html).toMatch(
      /<div class="ird-supporting-text" data-no-variants hidden>iRaceDeck has no ready-made profiles for this Stream Deck yet\.<\/div><\/ird-profile-variants>/,
    );
  });

  it("renders nothing with the profiles flag off", () => {
    expect(render({ settingsWindow: true, platform: { features: { profiles: false } } }).trim()).toBe("");
  });
});

describe("global-stream-deck-profiles.ejs in a Property Inspector", () => {
  it("keeps its plain rows: no picker, no device types, no wrapper", () => {
    const html = render({}, fixture);

    expect(html).toContain(
      '<sdpi-item label="iRaceDeck Default"><ird-profile-switch profile="iRaceDeck Default" label="Switch"></ird-profile-switch></sdpi-item>' +
        '<sdpi-item label="iRaceDeck Replay"><ird-profile-switch profile="iRaceDeck Replay" label="Switch"></ird-profile-switch></sdpi-item>',
    );
    expect(html).not.toContain("ird-deck-device-select");
    expect(html).not.toContain("data-device-types");
    expect(html).not.toContain("ird-profile-variants");
    expect(html).not.toContain("data-no-variants");
  });
});
