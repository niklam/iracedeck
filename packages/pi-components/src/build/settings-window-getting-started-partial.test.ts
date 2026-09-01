import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/settings-window-getting-started.ejs` (not a fixture).
 *
 * The page exists to be read by somebody who has just installed iRaceDeck, so
 * these tests pin the properties that makes it worth having at all: it renders
 * from the build's own artifact rather than the network, the prose survives to
 * the page intact, and the platform split falls where #1061 says it does —
 * Profiles PROSE everywhere, the Profiles CONTROL only where that tab exists.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const repoRoot = path.resolve(partialsDir, "../../..");
const DATA = path.join(repoRoot, "packages/iracing-actions/src/actions/data/getting-started.json");

const FIXTURE = {
  _meta: { generatedFrom: "…", generatedBy: "…", note: "…" },
  sections: [
    {
      title: "Start from a ready-made layout",
      blocks: [
        { type: "paragraph", html: "Ready-made layouts are a <strong>Stream Deck</strong> feature." },
        { type: "action", id: "open-profiles-tab" },
      ],
    },
    {
      title: "Meet your Race Engineer",
      blocks: [
        { type: "list", items: ["<strong>Fuel Service</strong> — sets the fuel"] },
        { type: "action", id: "enable-race-engineer" },
        { type: "action", id: "open-updates-tab" },
      ],
    },
  ],
};

/** Stands in for the compile plugin's `require`, which only resolves `data/*.json`. */
function render(data: unknown = FIXTURE, platform?: unknown): string {
  return ejs.render(
    "<%- include('settings-window-getting-started') %>",
    { require: () => data, platform },
    { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
  );
}

describe("settings-window-getting-started.ejs", () => {
  it("renders every section, in the order the page authors them", () => {
    const html = render();

    expect(html.match(/<section class="sw-gs-section">/g)).toHaveLength(2);
    expect(html.indexOf("Start from a ready-made layout")).toBeLessThan(html.indexOf("Meet your Race Engineer"));
  });

  it("emits prose HTML raw, so the generator's escaping is not applied twice", () => {
    expect(render()).toContain("<strong>Stream Deck</strong>");
  });

  it("renders a list as a list", () => {
    const html = render();

    expect(html).toContain('<ul class="sw-gs-list">');
    expect(html).toContain("<li><strong>Fuel Service</strong> — sets the fuel</li>");
  });

  it("never reaches the website for its content", () => {
    const html = render();

    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("fetch(");
  });

  describe("the platform split", () => {
    it("renders the Profiles control where the tab exists", () => {
      expect(render(FIXTURE, { features: { profiles: true } })).toContain('data-jump="profiles"');
    });

    it("defaults to rendering it when no platform is supplied at all", () => {
      // The `!== false` convention: absent means enabled, matching every other
      // flag check in the PI templates.
      expect(render()).toContain('data-jump="profiles"');
    });

    it("drops the control where the Profiles tab does not exist, but keeps the prose", () => {
      const html = render(FIXTURE, { features: { profiles: false } });

      // The failure mode this guards is a Mirabox user reading about a button
      // they do not have — and the opposite one, losing the advertising #1061
      // asks for on every platform. The prose says "Stream Deck" in its own
      // words, so it is correct everywhere; only the jump would go nowhere.
      expect(html).not.toContain('data-jump="profiles"');
      expect(html).toContain("Ready-made layouts are a <strong>Stream Deck</strong> feature.");
    });
  });

  it("renders the one-press opt-in as a control that knows its own state", () => {
    expect(render()).toContain('<ird-enable-feature feature="race-engineer">');
  });

  it("sends the reader to the What's New tab rather than binding the setting twice", () => {
    // Two sdpi controls bound to one key on one page go stale against each
    // other: the fake host deliberately skips the echo to whichever socket
    // wrote (#992), so the untouched one keeps showing the old value and writes
    // it straight back when touched. A jump says the same thing with one binding.
    const html = render();

    expect(html).toContain('data-jump="updates"');
    expect(html).not.toContain('setting="changelogNotification"');
  });

  it("fails the build on an action id nothing renders", () => {
    // Silently omitting it would be invisible on BOTH surfaces: the website
    // renders no controls, and the pane would simply have a gap. Nobody would
    // ever learn the control was missing.
    const rogue = { sections: [{ title: "S", blocks: [{ type: "action", id: "not-a-real-control" }] }] };

    expect(() => render(rogue)).toThrow(/unknown action id "not-a-real-control"/);
  });

  describe("the committed artifact", () => {
    it("uses only action ids this partial can render", () => {
      const committed = JSON.parse(readFileSync(DATA, "utf-8"));

      expect(() => render(committed)).not.toThrow();
    });

    it("carries the controls the page's copy promises", () => {
      const html = render(JSON.parse(readFileSync(DATA, "utf-8")));

      for (const feature of ["race-engineer", "changelog-updates", "focus-iracing-window"]) {
        expect(html, `missing the ${feature} control`).toContain(`<ird-enable-feature feature="${feature}">`);
      }

      expect(html).toContain('data-jump="engineer"');
      expect(html).toContain('data-jump="profiles"');
    });
  });
});
