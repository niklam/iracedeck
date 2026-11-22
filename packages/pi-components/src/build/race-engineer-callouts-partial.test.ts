// @vitest-environment jsdom
import { CALLOUT_SETTING_KEYS } from "@iracedeck/callout-settings";
import ejs from "ejs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { loadCalloutPiSections } from "./callout-pi-groups.mjs";

/**
 * Renders the REAL `partials/race-engineer-callouts.ejs`, the settings
 * window's Race Engineer Callouts card (#1350, #1700). Most cases render the
 * sections exactly as the build reads them — from the built
 * `@iracedeck/callout-settings` registry, in a fresh process — so they hold
 * what the plugins ship; the rules that must hold whatever the registry holds
 * (escaping, the feature-flag fallbacks, the map's guard) render fixtures.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

type Row = { setting: string; label: string; description: string | null; on: boolean; feature: string | null };
type Heading = { id: string; title: string; description: string; rows: Row[] };
type Section = { id: string; title: string; groups: Heading[] };

/** The sections exactly as the build reads them. */
const calloutPiSections: Section[] = loadCalloutPiSections().sections;

/** The heading ids the partial appends non-callout items to (its HEADING_EXTRAS map). */
const EXTRAS_IDS = ["opponent-flags", "gaps", "spotter", "traffic", "fuel", "corner-names"] as const;

/** Every platform flag a row names, on, as in a development build with all of them (#1113). */
const ALL_FEATURES = Object.fromEntries(
  calloutPiSections.flatMap((s) =>
    s.groups.flatMap((g) => g.rows.flatMap((r) => (r.feature === null ? [] : [[r.feature, true]]))),
  ),
);

function render(data: Record<string, unknown>): string {
  return ejs.render("<%- include('race-engineer-callouts') %>", data, {
    views: [partialsDir],
    filename: path.join(partialsDir, "_test.ejs"),
  });
}

function parse(html: string): HTMLElement {
  const host = document.createElement("div");

  host.innerHTML = html;

  return host;
}

/** The rows a render without `platform` shows: a flagged row is left out (#1113). */
const shownInRelease = (r: Row): boolean => r.feature === null;

/** A heading of plain rows, for fixtures. */
function heading(id: string, rows: Partial<Row>[] = [{}]): Heading {
  return {
    id,
    title: `Title ${id}`,
    description: `Description of ${id}.`,
    rows: rows.map((r, i) => ({
      setting: `calloutEnabled${id.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}${i}`,
      label: `Label ${id} ${i}`,
      description: null,
      on: true,
      feature: null,
      ...r,
    })),
  };
}

/** A registry-shaped fixture holding every heading the partial's map names, so it renders on its own. */
function fixtureSections(extra: Section[] = []): Section[] {
  return [{ id: "carriers", title: "Carriers", groups: EXTRAS_IDS.map((id) => heading(id)) }, ...extra];
}

describe("race-engineer-callouts.ejs: the registry's keys", () => {
  it("renders every registry key exactly once with every row's flag on (#1350)", () => {
    const html = render({ calloutPiSections, platform: { features: ALL_FEATURES } });

    for (const key of CALLOUT_SETTING_KEYS) {
      expect(html.split(`setting="${key}"`).length - 1, key).toBe(1);
    }

    expect((html.match(/setting="calloutEnabled/g) ?? []).length).toBe(CALLOUT_SETTING_KEYS.length);
  });

  it("renders every key but a flagged row's once without the flags, as a release build (#1113)", () => {
    const html = render({ calloutPiSections });
    const flagged = new Set(
      calloutPiSections
        .flatMap((s) => s.groups.flatMap((g) => g.rows.filter((r) => r.feature !== null)))
        .map((r) => r.setting),
    );

    expect([...flagged]).toEqual(["calloutEnabledTrafficRejoin"]);

    for (const key of CALLOUT_SETTING_KEYS) {
      expect(html.split(`setting="${key}"`).length - 1, key).toBe(flagged.has(key) ? 0 : 1);
    }
  });

  it("lays out the per-callout opt-ins with their registry labels", () => {
    const html = render({ calloutPiSections });

    // The tire wear report (issue #1108) sits with the pit-service readbacks it follows.
    expect(html).toContain('setting="calloutEnabledTireWearReport" label="Tire wear report"');
    // The Furled opt-in names what the engineer now says; its key is unchanged (#1274).
    expect(html).toContain('setting="calloutEnabledOpponentFlagFurled" label="Slowdown (furled black flag)"');
    expect(html).not.toContain("Furled black flag (warning)");
  });

  // The truthy-attribute sdpi-checkbox trap: `default="false"` renders CHECKED,
  // so an off default must carry no `default` attribute at all.
  it('an off-default callout has no default attribute, an on one has default="true" (#1350)', () => {
    const html = render({ calloutPiSections });

    expect(html).toContain(
      '<sdpi-checkbox setting="calloutEnabledFuelLapsLeft10" label="10 laps of fuel left" global></sdpi-checkbox>',
    );
    expect(html).toContain(
      '<sdpi-checkbox setting="calloutEnabledFuelLapsLeft5" label="5 laps of fuel left" global default="true"></sdpi-checkbox>',
    );
    expect(html).not.toContain('default="false"');

    const boxes = Array.from(parse(html).querySelectorAll('sdpi-checkbox[setting^="calloutEnabled"]'));
    const rows = new Map(calloutPiSections.flatMap((s) => s.groups.flatMap((g) => g.rows)).map((r) => [r.setting, r]));

    expect(boxes.length).toBeGreaterThan(0);

    for (const box of boxes) {
      const row = rows.get(box.getAttribute("setting")!)!;

      expect(box.getAttribute("default"), row.setting).toBe(row.on ? "true" : null);
      expect(box.hasAttribute("global"), row.setting).toBe(true);
    }
  });
});

describe("race-engineer-callouts.ejs: sections (#1700)", () => {
  const html = render({ calloutPiSections });
  const root = parse(html);
  const details = Array.from(root.querySelectorAll("details"));

  it('renders one closed <details class="ird-callout-section"> per section, in registry order', () => {
    expect(details.map((d) => d.getAttribute("data-callout-section"))).toEqual(calloutPiSections.map((s) => s.id));

    for (const section of details) {
      expect(section.className).toBe("ird-callout-section");
      // Closed on every open of the window: no `open` attribute is rendered.
      expect(section.hasAttribute("open"), section.dataset.calloutSection).toBe(false);
      expect(section.open).toBe(false);
      expect(section.parentElement).toBe(root);
    }

    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  // head-common.ejs binds every `.ird-collapsible[data-accordion-id]` to the
  // `_accordionState` global setting: a section carrying either would write
  // every open and close into the user's settings.
  it("never carries ird-collapsible or data-accordion-id", () => {
    expect(html).not.toContain("ird-collapsible");
    expect(html).not.toContain("data-accordion-id");
  });

  it("gives each section a summary with its title, its count and its heading titles", () => {
    for (const [i, section] of calloutPiSections.entries()) {
      const summary = details[i]!.firstElementChild!;

      expect(summary.tagName).toBe("SUMMARY");
      expect(summary.className).toBe("ird-callout-section-summary");
      expect(Array.from(summary.children).map((c) => c.className || c.tagName.toLowerCase())).toEqual([
        "ird-callout-section-title",
        "ird-callout-count",
        "ird-callout-section-headings",
      ]);
      expect(summary.querySelector(".ird-callout-section-title")!.textContent).toBe(section.title);
      expect(summary.querySelector(".ird-callout-section-headings")!.textContent).toBe(
        section.groups.map((g) => g.title).join(" · "),
      );
    }
  });

  it("puts each heading inside its section, in order, its description directly under its title", () => {
    for (const [i, section] of calloutPiSections.entries()) {
      const headings = Array.from(details[i]!.children).slice(1);

      expect(headings.map((h) => h.getAttribute("data-callout-group"))).toEqual(section.groups.map((g) => g.id));

      for (const [j, group] of section.groups.entries()) {
        const block = headings[j]!;
        const [title, description] = Array.from(block.children);

        expect(block.className).toBe("ird-callout-heading");
        expect(title!.className).toBe("ird-callout-heading-title");
        expect(title!.textContent).toBe(group.title);
        expect(description!.className).toBe("ird-callout-heading-description");
        expect(description!.textContent).toBe(group.description);
      }
    }
  });

  it("renders each heading's rows in registry order, one row per entry, as the release build shows them", () => {
    for (const section of calloutPiSections) {
      for (const group of section.groups) {
        const block = root.querySelector(`[data-callout-group="${group.id}"]`)!;
        const rows = Array.from(block.querySelectorAll(":scope > .ird-callout-rows > .ird-callout-row"));
        const shown = group.rows.filter(shownInRelease);

        expect(
          rows.map((r) => r.querySelector("sdpi-checkbox")!.getAttribute("setting")),
          group.id,
        ).toEqual(shown.map((r) => r.setting));
      }
    }
  });

  it("renders an entry description exactly where the entry has one, as the second line under its checkbox", () => {
    const html = render({ calloutPiSections, platform: { features: ALL_FEATURES } });
    const all = parse(html);
    const rows = calloutPiSections.flatMap((s) => s.groups.flatMap((g) => g.rows));

    for (const row of rows) {
      const element = all.querySelector(`sdpi-checkbox[setting="${row.setting}"]`)!.parentElement!;
      const children = Array.from(element.children);

      expect(element.className, row.setting).toBe("ird-callout-row");
      expect(children[0]!.tagName, row.setting).toBe("SDPI-CHECKBOX");

      if (row.description === null) {
        expect(children, row.setting).toHaveLength(1);
      } else {
        expect(children, row.setting).toHaveLength(2);
        expect(children[1]!.className).toBe("ird-callout-row-description");
        expect(children[1]!.textContent).toBe(row.description);
      }
    }

    expect(all.querySelectorAll(".ird-callout-row-description")).toHaveLength(
      rows.filter((r) => r.description !== null).length,
    );
  });

  it.each([
    ["a release build (no platform)", {}],
    ["a development build with every flag on", { platform: { features: ALL_FEATURES } }],
  ])("starts each section's count at the on-defaults over the rows it renders, in %s", (_, locals) => {
    const rendered = parse(render({ calloutPiSections, ...locals }));
    const features = (locals as { platform?: { features: Record<string, boolean> } }).platform?.features ?? {};

    for (const section of calloutPiSections) {
      const rows = section.groups.flatMap((g) => g.rows).filter((r) => r.feature === null || features[r.feature]);
      const count = rendered.querySelector(`[data-callout-section="${section.id}"] ird-callout-count`)!;

      expect(count.textContent, section.id).toBe(`${rows.filter((r) => r.on).length} of ${rows.length} on`);
      expect(
        rendered.querySelectorAll(`[data-callout-section="${section.id}"] sdpi-checkbox[setting^="calloutEnabled"]`),
      ).toHaveLength(rows.length);
    }
  });
});

describe("race-engineer-callouts.ejs: the non-callout items (#1700)", () => {
  const html = render({ calloutPiSections });
  const root = parse(html);

  /** The raw markup of one heading's block, as rendered. */
  function blockSource(id: string): string {
    const start = html.indexOf(`<div class="ird-callout-heading" data-callout-group="${id}">`);
    const next = html.indexOf('<div class="ird-callout-heading" ', start + 1);
    const close = html.indexOf("</details>", start);

    expect(start, id).toBeGreaterThanOrEqual(0);

    return html.slice(start, next !== -1 && next < close ? next : close);
  }

  it.each([
    ["opponent-flags", ["opponentFlagRangeSeconds"]],
    ["gaps", ["gapAlertThresholdSeconds", "gapCalloutCooldownSeconds", "gapCalloutMinChangeSeconds"]],
    ["spotter", ["spotterStillThereSeconds"]],
    ["traffic", ["trafficPitExitBeforeSeconds", "trafficPitExitAfterSeconds", "trafficPitExitMergeWarnSeconds"]],
    ["fuel", ["fuelCalloutMarginLaps"]],
    ["corner-names", ["cornerCalloutLeadSeconds"]],
  ])("renders %s's sliders and supporting text inside its heading block, after its rows", (id, settings) => {
    const block = root.querySelector(`[data-callout-group="${id}"]`)!;
    const children = Array.from(block.children);
    const rowsAt = children.findIndex((c) => c.classList.contains("ird-callout-rows"));
    const items = children.slice(rowsAt + 1);

    expect(rowsAt, `${id} has its rows`).toBe(2);
    expect(items.length, `${id} has items after its rows`).toBeGreaterThan(0);

    for (const item of items) expect(["SDPI-ITEM", "DIV"]).toContain(item.tagName);

    for (const item of items.filter((c) => c.tagName === "DIV")) expect(item.className).toBe("ird-supporting-text");

    expect(
      items.flatMap((c) => Array.from(c.querySelectorAll("ird-range-input")).map((r) => r.getAttribute("setting"))),
    ).toEqual(settings);

    // Each slider appears once on the card, in this heading and nowhere else.
    for (const setting of settings) expect(html.split(`setting="${setting}"`).length - 1, setting).toBe(1);
  });

  it("renders sliders only under those six headings", () => {
    const owners = Array.from(root.querySelectorAll("ird-range-input")).map((r) =>
      r.closest("[data-callout-group]")!.getAttribute("data-callout-group"),
    );

    expect([...new Set(owners)].sort()).toEqual([...EXTRAS_IDS].sort());
  });

  it("puts the opponent-flag range directly under the Opponent Flags rows, closing the heading (#1274)", () => {
    const range =
      '<sdpi-item label="Opponent flag range (s)">' +
      '<ird-range-input setting="opponentFlagRangeSeconds" min="1" max="10" step="1" default="3" global showlabels></ird-range-input>' +
      "</sdpi-item>" +
      '<div class="ird-supporting-text">Only cars in your class this close ahead or behind in the race are announced.</div>';
    const block = blockSource("opponent-flags");

    // The last row and the rows block close, then the range, then the heading closes.
    expect(block).toContain(`</div></div>${range}</div>`);
    expect(block.indexOf(range)).toBeGreaterThan(block.indexOf('setting="calloutEnabledOpponentFlagDisqualify"'));
  });

  it("keeps the corner data attribution word for word, as its own supporting text in the Corner Names heading", () => {
    const attribution =
      '<div class="ird-supporting-text">Corner data &copy; 2025 <a href="https://github.com/Lovely-Sim-Racing/lovely-track-data" target="_blank" rel="noopener noreferrer">Lovely Sim Racing</a> (lovely-track-data, modified: pruned and normalized), corner names by Racing Circuits &mdash; <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-NC-SA 4.0</a>, used with permission.</div>';
    const block = blockSource("corner-names");

    expect(block).toContain(attribution);
    expect(block.indexOf(attribution)).toBeLessThan(block.indexOf('setting="cornerCalloutLeadSeconds"'));
    expect(html.split("Lovely Sim Racing</a>").length - 1).toBe(1);
  });

  it("keeps the fuel text after its first sentence, which became the Fuel heading description", () => {
    const block = blockSource("fuel");

    expect(block).toContain(
      '<div class="ird-supporting-text">"Box this lap" fires when the tank won\'t cover another full lap. Warnings stay silent when the fuel covers what\'s left of the race — lap-limited and timed races both — and "Enough fuel to finish" confirms it once, inside the last 10 laps.</div>',
    );
    expect(block.indexOf('"Box this lap"')).toBeLessThan(block.indexOf('setting="fuelCalloutMarginLaps"'));
  });

  it("no longer repeats the two sentences that moved into heading descriptions as supporting text", () => {
    const supporting = Array.from(root.querySelectorAll(".ird-supporting-text")).map((d) => d.textContent ?? "");

    for (const text of supporting) {
      expect(text).not.toContain("Estimated laps of fuel left");
      expect(text).not.toContain("Announces the upcoming corner");
    }
  });
});

describe("race-engineer-callouts.ejs: the rules that hold whatever the registry holds", () => {
  it("fails loudly without calloutPiSections", () => {
    expect(() => render({})).toThrow(/calloutPiSections/);
  });

  it.each(EXTRAS_IDS)("throws when its non-callout items name a heading that no longer exists (%s)", (id) => {
    const without = calloutPiSections.map((s) => ({ ...s, groups: s.groups.filter((g) => g.id !== id) }));

    expect(() => render({ calloutPiSections: without })).toThrow(new RegExp(`HEADING_EXTRAS names "${id}"`));
  });

  it("renders the fixture on its own (the fixture holds every heading the map names)", () => {
    expect(() => render({ calloutPiSections: fixtureSections() })).not.toThrow();
  });

  describe("escaping", () => {
    const NASTY = `Tom & Jerry's <b>"bold"</b> <script>alert(1)</script>`;
    const ESCAPED = "Tom &amp; Jerry&#39;s &lt;b&gt;&quot;bold&quot;&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;";
    const section: Section = {
      id: "nasty",
      title: `Section ${NASTY}`,
      groups: [
        {
          id: "nasty-heading",
          title: `Heading ${NASTY}`,
          description: `Description ${NASTY}`,
          rows: [
            {
              setting: "calloutEnabledNasty",
              label: `Label ${NASTY}`,
              description: `Entry ${NASTY}`,
              on: true,
              feature: null,
            },
          ],
        },
      ],
    };
    const html = render({ calloutPiSections: fixtureSections([section]) });
    const nasty = parse(html).querySelector('[data-callout-section="nasty"]')!;

    it("escapes &, <, >, \" and ' in every title, label and description, in attributes and in text", () => {
      expect(html).toContain(`<span class="ird-callout-section-title">Section ${ESCAPED}</span>`);
      expect(html).toContain(`<span class="ird-callout-section-headings">Heading ${ESCAPED}</span>`);
      expect(html).toContain(`<div class="ird-callout-heading-title">Heading ${ESCAPED}</div>`);
      expect(html).toContain(`<div class="ird-callout-heading-description">Description ${ESCAPED}</div>`);
      expect(html).toContain(`<sdpi-checkbox setting="calloutEnabledNasty" label="Label ${ESCAPED}" global`);
      expect(html).toContain(`<div class="ird-callout-row-description">Entry ${ESCAPED}</div>`);
    });

    it("never lets the fixture's markup through raw", () => {
      expect(html).not.toContain("<b>");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain(`"bold"`);
      expect(html).not.toContain("Jerry's");
      expect(nasty.querySelector("b, script")).toBeNull();
    });

    it("reads back as the original text in the browser", () => {
      expect(nasty.querySelector(".ird-callout-section-title")!.textContent).toBe(`Section ${NASTY}`);
      expect(nasty.querySelector(".ird-callout-section-headings")!.textContent).toBe(`Heading ${NASTY}`);
      expect(nasty.querySelector(".ird-callout-heading-title")!.textContent).toBe(`Heading ${NASTY}`);
      expect(nasty.querySelector(".ird-callout-heading-description")!.textContent).toBe(`Description ${NASTY}`);
      expect(nasty.querySelector("sdpi-checkbox")!.getAttribute("label")).toBe(`Label ${NASTY}`);
      expect(nasty.querySelector(".ird-callout-row-description")!.textContent).toBe(`Entry ${NASTY}`);
    });

    it("does not escape the setting key", () => {
      expect(nasty.querySelector("sdpi-checkbox")!.getAttribute("setting")).toBe("calloutEnabledNasty");
    });
  });

  describe("a heading whose rows are all hidden by feature flags", () => {
    const FLAGGED: Partial<Row> = { feature: "someDevFlag" };
    const sections = (): Section[] => {
      const base = fixtureSections();
      const carriers = base[0]!;

      // A carrier of sliders whose one row is flagged, beside a plain heading.
      carriers.groups = carriers.groups.map((g) => (g.id === "gaps" ? heading("gaps", [FLAGGED]) : g));

      return [
        carriers,
        {
          id: "mixed",
          title: "Mixed",
          groups: [heading("plain", [{}, { on: false }]), heading("only-flagged", [FLAGGED, FLAGGED])],
        },
        { id: "all-flagged", title: "All flagged", groups: [heading("lonely", [FLAGGED])] },
      ];
    };

    it("keeps a heading with non-callout items, with no rows block, and leaves it out of the count", () => {
      const root = parse(render({ calloutPiSections: sections() }));
      const gaps = root.querySelector('[data-callout-group="gaps"]')!;

      expect(gaps.querySelector(".ird-callout-rows")).toBeNull();
      expect(gaps.querySelector(".ird-callout-heading-title")!.textContent).toBe("Title gaps");
      expect(gaps.querySelector(".ird-callout-heading-description")!.textContent).toBe("Description of gaps.");
      expect(gaps.querySelector('ird-range-input[setting="gapAlertThresholdSeconds"]')).not.toBeNull();
      // Five carriers with one row each are counted; the hidden gaps row is not.
      expect(root.querySelector('[data-callout-section="carriers"] ird-callout-count')!.textContent).toBe("5 of 5 on");
      expect(
        root.querySelector('[data-callout-section="carriers"] .ird-callout-section-headings')!.textContent,
      ).toContain("Title gaps");
    });

    it("leaves out a heading with nothing to show, and its title from the summary", () => {
      const root = parse(render({ calloutPiSections: sections() }));
      const mixed = root.querySelector('[data-callout-section="mixed"]')!;

      expect(mixed.querySelector('[data-callout-group="only-flagged"]')).toBeNull();
      expect(mixed.querySelector(".ird-callout-section-headings")!.textContent).toBe("Title plain");
      expect(mixed.querySelector("ird-callout-count")!.textContent).toBe("1 of 2 on");
    });

    it("leaves out a section with no heading to show", () => {
      const html = render({ calloutPiSections: sections() });

      expect(html).not.toContain('data-callout-section="all-flagged"');
      expect(html).not.toContain("All flagged");
    });

    it("shows all of them, counted, once the build's flags have theirs on", () => {
      const root = parse(render({ calloutPiSections: sections(), platform: { features: { someDevFlag: true } } }));

      expect(root.querySelector('[data-callout-group="gaps"] .ird-callout-rows')).not.toBeNull();
      expect(root.querySelector('[data-callout-group="only-flagged"]')).not.toBeNull();
      expect(root.querySelector('[data-callout-section="mixed"] ird-callout-count')!.textContent).toBe("3 of 4 on");
      expect(root.querySelector('[data-callout-section="all-flagged"] ird-callout-count')!.textContent).toBe(
        "1 of 1 on",
      );
    });

    it("a flag set to anything but true leaves the rows out (a development flag fails closed)", () => {
      const html = render({ calloutPiSections: sections(), platform: { features: { someDevFlag: "true" } } });

      expect(html).not.toContain('data-callout-group="only-flagged"');
    });
  });
});
