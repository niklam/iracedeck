import { renderPartial } from "@iracedeck/pi-components/testing";
import { describe, expect, it } from "vitest";

import { readActionsData } from "./action-templates.test-support.js";

/**
 * This package's `actions/data/` JSON through the `@iracedeck/pi-components`
 * partials that render it (#1375). The plugin build hands a partial's
 * `require('./data/…')` this folder, so the committed data is part of what each
 * partial ships. The partials' own behaviour is tested beside them in
 * `pi-components` against fixtures; what is held here is that the real data
 * renders, and renders all of itself.
 */

type ProfileRow = { name: string; deviceType?: number; displayName?: string };

/** A `require` that answers only `./data/<file>`, as the compile plugin does for these partials. */
function dataRequire(file: string, data: unknown): (spec: string) => unknown {
  return (spec: string) => {
    if (spec !== `./data/${file}`) throw new Error(`unexpected require: ${spec}`);

    return data;
  };
}

describe("data/profiles.json", () => {
  const profiles = readActionsData<ProfileRow[]>("profiles.json");
  const templates = [...new Set(profiles.map((p) => p.displayName ?? p.name))];
  const require = dataRequire("profiles.json", profiles);

  /** The `data-device-types` each row carries, keyed by its label. */
  function rowTypes(html: string): Record<string, string> {
    return Object.fromEntries(
      [...html.matchAll(/<sdpi-item label="([^"]+)" data-device-types="([^"]*)">/g)].map((m) => [m[1], m[2]]),
    );
  }

  it("global-stream-deck-profiles.ejs puts every template's row inside ird-profile-variants, bound to the deck picker (#1457)", () => {
    const html = renderPartial("global-stream-deck-profiles", { require, settingsWindow: true });
    const wrapper = /<ird-profile-variants device-from="sw-deck-device">([\s\S]*?)<\/ird-profile-variants>/.exec(html);

    expect(html).toContain('<ird-deck-device-select select-id="sw-deck-device">');
    expect(wrapper).not.toBeNull();
    const label = (name: string): string => name.replace(/^iRaceDeck /, "");

    expect(Object.keys(rowTypes(wrapper![1]))).toEqual(templates.map(label));

    for (const name of templates) {
      const types = profiles.filter((p) => (p.displayName ?? p.name) === name).map((p) => p.deviceType);

      expect(rowTypes(html)[label(name)]!.split(",").map(Number).sort(), name).toEqual([...new Set(types)].sort());
    }
  });

  it("global-profile-auto-switch.ejs offers Do not change the profile first, then every template once, in every row (#1111)", () => {
    const html = renderPartial("global-profile-auto-switch", { require });
    const rows = [
      ...html.matchAll(/<sdpi-item label="([^"]+)">\s*<sdpi-select[^>]*>([\s\S]*?)<\/sdpi-select>\s*<\/sdpi-item>/g),
    ].map((m) => ({
      label: m[1]!,
      options: [...m[2]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((o) => [o[1]!, o[2]!]),
    }));

    expect(templates.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.options, row.label).toEqual([
        ["", "Do not change the profile"],
        ...templates.map((name): [string, string] => [name, name.replace(/^iRaceDeck /, "")]),
      ]);
    }
  });
});

describe("data/getting-started.json through settings-window-getting-started.ejs", () => {
  const render = (): string =>
    renderPartial("settings-window-getting-started", {
      require: dataRequire("getting-started.json", readActionsData("getting-started.json")),
      platform: undefined,
    });

  it("uses only action ids the partial can render", () => {
    expect(() => render()).not.toThrow();
  });

  it("carries the controls the page's copy promises", () => {
    const html = render();

    for (const feature of ["race-engineer", "changelog-updates", "focus-iracing-window"]) {
      expect(html, `missing the ${feature} control`).toContain(`<ird-enable-feature feature="${feature}">`);
    }

    expect(html).toContain('data-jump="engineer"');
    expect(html).toContain('data-jump="profiles"');
  });
});
