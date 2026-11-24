import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  adjustOptions,
  badgeModes,
  checkFeatureCounts,
  parseHomeStats,
  parseOverviewRows,
  parseReadmeRows,
  readFeatureCountInputs,
} from "./lib/feature-counts.mjs";

/**
 * The README's and the website's feature counts against the code (#1271).
 * What is checked, and in what order, is in `scripts/lib/feature-counts.mjs`.
 *
 * The suite reads the real checkout once, asserts it is clean, then breaks one
 * input at a time in memory and asserts the break is named. Those breaks are
 * the positive controls: a parser that matched nothing would leave the real
 * check green for the wrong reason, and each of them would then stay green too.
 */
const root = path.resolve(import.meta.dirname, "..");
const real = readFeatureCountInputs(root);

/** A deep copy with one input rewritten. */
function withInput(key, rewrite) {
  const copy = structuredClone(real);
  copy[key] = rewrite(copy[key]);
  return copy;
}

/** Replaces exactly one occurrence, failing the test if there is not exactly one. */
function replaceOnce(text, from, to) {
  const count = text.split(from).length - 1;
  expect(count, `"${from}" should occur exactly once`).toBe(1);
  return text.replace(from, to);
}

describe("feature counts (#1271)", () => {
  it("reads every input at all", () => {
    // Guards the parsers: empty results would make the clean check vacuous.
    expect(real.pages.length).toBeGreaterThan(30);
    expect(parseOverviewRows(real.overview)).toHaveLength(10);
    expect(parseReadmeRows(real.readme)).toHaveLength(10);
    expect(Object.keys(parseHomeStats(real.home))).toEqual(expect.arrayContaining(["Actions", "Modes", "Categories"]));
    expect(real.pages.filter((p) => p.category === "car-setup").every((p) => adjustOptions(p.ejs) > 0)).toBe(true);
  });

  it("finds the README and the website in line with the code", () => {
    expect(checkFeatureCounts(real)).toEqual([]);
  });

  describe("names each break (positive controls)", () => {
    const overviewRows = parseOverviewRows(real.overview);
    const total = overviewRows.reduce((s, r) => s + r.modes, 0);

    it("a stale README headline, as #1271 found it", () => {
      const broken = withInput("readme", (t) => replaceOnce(t, `**${total} modes**`, "**265+ modes**"));
      expect(checkFeatureCounts(broken)).toEqual([`README.md: states 265+ modes; the code has ${total}`]);
    });

    it("a README headline with a wrong number", () => {
      const broken = withInput("readme", (t) => replaceOnce(t, `**${total} modes**`, `**${total - 1} modes**`));
      expect(checkFeatureCounts(broken)).toEqual([`README.md: states ${total - 1} modes; the code has ${total}`]);
    });

    it("a README row with a wrong mode count", () => {
      const broken = withInput("readme", (t) => t.replace(/^(\| \*\*Media\*\*\s*\|\s*1\s*\|\s*)7(\s*\|)/m, "$18$2"));
      expect(broken.readme).not.toBe(real.readme);
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        /README\.md: "Media" states 1 action \/ 8 modes; the overview states 1 \/ 7/,
      );
    });

    it("a README table missing a category", () => {
      const broken = withInput("readme", (t) => t.replace(/^\| \*\*Audio & Voice\*\*.*\r?\n/m, ""));
      expect(broken.readme).not.toBe(real.readme);
      expect(checkFeatureCounts(broken).join("\n")).toMatch(/README\.md: Features table names \[Display & Session/);
    });

    it("an overview row whose mode count no longer matches its pages", () => {
      const broken = withInput("overview", (t) => t.replace(/^(\| \[Media\]\([^)]*\) \| 1 \| )7( \|)/m, "$16$2"));
      expect(broken.overview).not.toBe(real.overview);
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        /overview\.md: "Media" states 6 modes; its actions count 7/,
      );
    });

    it("a page whose badge gains a mode", () => {
      const broken = structuredClone(real);
      const page = broken.pages.find((p) => p.slug === "media-capture");
      page.text = replaceOnce(page.text, 'text: "7 modes"', 'text: "8 modes"');
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        /overview\.md: "Media" states 7 modes; its actions count 8/,
      );
    });

    it("a page with no mode count in its badge", () => {
      const broken = structuredClone(real);
      const page = broken.pages.find((p) => p.slug === "media-capture");
      page.text = replaceOnce(page.text, 'text: "7 modes"', 'text: "New"');
      expect(checkFeatureCounts(broken).join("\n")).toMatch(/media-capture\.md: its sidebar badge names no mode count/);
    });

    it("a Car Setup template that gains an Adjust option", () => {
      const broken = structuredClone(real);
      const page = broken.pages.find((p) => p.slug === "setup-aero");
      page.ejs = page.ejs.replace(/(<optgroup label="Adjust">)/, '$1\n<option value="new-wing">New Wing</option>');
      expect(page.ejs).not.toBe(real.pages.find((p) => p.slug === "setup-aero").ejs);
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        /overview\.md: "Car Setup" states 44 modes; its actions count 45/,
      );
    });

    it("a hidden Adjust option does not count", () => {
      expect(
        adjustOptions(
          '<sdpi-item label="Mode"><optgroup label="Adjust"><option value="a">A</option><option value="b" hidden>B</option></optgroup></sdpi-item>',
        ),
      ).toBe(1);
    });

    it("a new visible action with no page", () => {
      const broken = structuredClone(real);
      broken.manifest.Actions.push({ UUID: "com.iracedeck.sd.core.new-action" });
      expect(checkFeatureCounts(broken)).toEqual([
        expect.stringMatching(/manifest\.json: visible action "new-action" has no page/),
      ]);
    });

    it("a new page in a new category", () => {
      const broken = structuredClone(real);
      broken.pages.push({
        category: "new-category",
        slug: "new-action",
        text: '---\nsidebar:\n  badge:\n    text: "2 modes"\n---\n',
      });
      broken.manifest.Actions.push({ UUID: "com.iracedeck.sd.core.new-action" });
      const out = checkFeatureCounts(broken).join("\n");
      expect(out).toMatch(/overview\.md: no category row links to \/docs\/actions\/new-category\//);
      expect(out).toMatch(/README\.md: states 33 actions; the code has 34/);
      expect(out).toMatch(/README\.md: states 10 categories; the code has 11/);
    });

    it("a stale docs landing page", () => {
      const broken = withInput("docsIndex", (t) => replaceOnce(t, `**${total} modes**`, "**277 modes**"));
      expect(checkFeatureCounts(broken)).toEqual([
        `${"packages/website/src/content/docs/docs/index.md"}: states 277 modes; the code has ${total}`,
      ]);
    });

    it("a stale home-page stat", () => {
      const broken = withInput("home", (t) =>
        replaceOnce(t, `<span class="stat-value">${total}</span>`, '<span class="stat-value">277</span>'),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        `packages/website/src/content/docs/index.mdx: states 277 modes; the code has ${total}`,
      ]);
    });
  });

  it("reads badges as the pages write them", () => {
    expect(badgeModes('---\nsidebar:\n  badge:\n    text: "13 modes + dial"\n---\n')).toBe(13);
    expect(badgeModes('---\nsidebar:\n  badge:\n    text: "1 mode"\n---\n')).toBe(1);
    expect(badgeModes('---\nsidebar:\n  badge:\n    text: "Elgato only"\n---\n')).toBeNull();
    expect(badgeModes("no frontmatter")).toBeNull();
  });
});
