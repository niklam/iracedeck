import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  adjustOptions,
  badgeModes,
  checkFeatureCounts,
  keypadModeOptions,
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

const PAGES = "packages/website/src/content/docs/docs/actions";
const ACTIONS = "packages/iracing-actions/src/actions";

/** A deep copy with one input rewritten. */
function withInput(key, rewrite) {
  const copy = structuredClone(real);
  copy[key] = rewrite(copy[key]);
  return copy;
}

/** A deep copy and the copy's page for `slug`, to break in place. */
function withPage(slug) {
  const copy = structuredClone(real);
  return [copy, copy.pages.find((p) => p.slug === slug)];
}

/** Replaces exactly one occurrence, failing the test if there is not exactly one. */
function replaceOnce(text, from, to) {
  const count = text.split(from).length - 1;
  expect(count, `"${from}" should occur exactly once`).toBe(1);
  return text.replace(from, to);
}

/** Like `String.replace` with a pattern, failing the test if nothing changed. */
function replaceMatch(text, pattern, to) {
  const out = text.replace(pattern, to);
  expect(out, `${pattern} should match`).not.toBe(text);
  return out;
}

const twoModeEjs =
  '<sdpi-item label="Mode"><sdpi-select><option value="a">A</option><option value="b">B</option></sdpi-select></sdpi-item>';

describe("feature counts (#1271)", () => {
  it("reads every input at all", () => {
    // Guards the parsers: empty results would make the clean check vacuous.
    expect(real.pages.length).toBeGreaterThan(30);
    expect(parseOverviewRows(real.overview)).toHaveLength(10);
    expect(parseReadmeRows(real.readme)).toHaveLength(10);
    expect(Object.keys(parseHomeStats(real.home))).toEqual(expect.arrayContaining(["Actions", "Modes", "Categories"]));
    expect(real.pages.filter((p) => p.category === "car-setup").every((p) => adjustOptions(p.ejs) > 0)).toBe(true);
    expect(real.pages.filter((p) => keypadModeOptions(p.ejs) > 1).length).toBeGreaterThan(25);
    expect(real.pages.filter((p) => badgeModes(p.text) > 1).length).toBeGreaterThan(25);
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
      const broken = withInput("readme", (t) =>
        replaceMatch(t, /^(\| \*\*Media\*\*\s*\|\s*1\s*\|\s*)7(\s*\|)/m, "$18$2"),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        'README.md: "Media" states 1 action / 8 modes; the code has 1 / 7',
      ]);
    });

    it("a README table missing a category", () => {
      const broken = withInput("readme", (t) => replaceMatch(t, /^\| \*\*Audio & Voice\*\*.*\r?\n/m, ""));
      expect(checkFeatureCounts(broken).join("\n")).toMatch(/README\.md: Features table names \[Display & Session/);
    });

    it("an overview row whose mode count no longer matches its pages", () => {
      const broken = withInput("overview", (t) => replaceMatch(t, /^(\| \[Media\]\([^)]*\) \| 1 \| )7( \|)/m, "$16$2"));
      expect(checkFeatureCounts(broken)).toEqual([
        `packages/website/src/content/docs/docs/actions/overview.md: "Media" states 6 modes; its actions count 7`,
      ]);
    });

    it("a page whose badge gains a mode", () => {
      const [broken, page] = withPage("media-capture");
      page.text = replaceOnce(page.text, 'text: "7 modes"', 'text: "8 modes"');
      expect(checkFeatureCounts(broken)).toEqual([
        `${PAGES}/media/media-capture.md: its badge states 8 modes; ${ACTIONS}/media-capture/media-capture.ejs offers 7`,
      ]);
    });

    it("a template that gains a keypad Mode option, with nothing else updated", () => {
      const [broken, page] = withPage("media-capture");
      page.ejs = replaceMatch(page.ejs, /(<sdpi-select\b[^>]*>)/, '$1\n<option value="new-mode">New Mode</option>');
      const out = checkFeatureCounts(broken).join("\n");
      expect(out).toMatch(/media-capture\.md: its badge states 7 modes; .*media-capture\.ejs offers 8/);
      expect(out).toMatch(/overview\.md: "Media" states 7 modes; its actions count 8/);
      expect(out).toContain(`README.md: states ${total} modes; the code has ${total + 1}`);
    });

    it("a page with no mode count in its badge", () => {
      const [broken, page] = withPage("media-capture");
      page.text = replaceOnce(page.text, 'text: "7 modes"', 'text: "New"');
      expect(checkFeatureCounts(broken)).toEqual([
        expect.stringMatching(/media-capture\.md: its sidebar badge names no mode count/),
      ]);
    });

    it("a single-mode page whose template gains a Mode select", () => {
      const [broken, page] = withPage("switch-profile");
      page.ejs = twoModeEjs;
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        /switch-profile\.md: SINGLE_MODE_PAGES counts it as 1 mode; .* offers 2/,
      );
    });

    it("a page with no template", () => {
      const [broken, page] = withPage("media-capture");
      page.ejs = null;
      expect(checkFeatureCounts(broken).join("\n")).toMatch(/media-capture\.ejs: not found/);
    });

    it("an option the script removes, once the template drops it", () => {
      const [broken, page] = withPage("pit-crew");
      page.ejs = replaceMatch(page.ejs, /<option value="radar-volume"[^>]*>[^<]*<\/option>/, "");
      expect(checkFeatureCounts(broken)).toEqual([
        'RUNTIME_REMOVED_OPTIONS names "pit-crew" / "radar-volume", which its keypad Mode select no longer has; remove it',
      ]);
    });

    it("a Car Setup template that gains an Adjust option", () => {
      const [broken, page] = withPage("setup-aero");
      page.ejs = replaceMatch(
        page.ejs,
        /(<optgroup label="Adjust">)/,
        '$1\n<option value="new-wing">New Wing</option>',
      );
      const out = checkFeatureCounts(broken).join("\n");
      expect(out).toMatch(/setup-aero\.md: its badge states 6 modes; .*setup-aero\.ejs offers 7/);
      expect(out).toMatch(/overview\.md: "Car Setup" states 44 modes; its actions count 45/);
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
        ejs: twoModeEjs,
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
        `packages/website/src/content/docs/docs/index.md: states 277 modes; the code has ${total}`,
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

  it("counts only the options a user can pick", () => {
    const ejs =
      '<sdpi-item label="Mode"><sdpi-select><option value="a">A</option><!-- <option value="b">B</option> -->' +
      '<option value="c" hidden>C</option><option value="d">D</option></sdpi-select></sdpi-item>';
    expect(keypadModeOptions(ejs)).toBe(2);
    expect(keypadModeOptions(ejs, ["d"])).toBe(1);
    expect(keypadModeOptions("<div></div>")).toBeNull();
    // An item never closed is not read to the end of the file.
    expect(keypadModeOptions('<sdpi-item label="Mode"><option value="a">A</option>')).toBeNull();
    expect(
      adjustOptions(
        '<sdpi-item label="Mode"><optgroup label="Adjust"><option value="a">A</option><option value="b" hidden>B</option></optgroup></sdpi-item>',
      ),
    ).toBe(1);
  });

  it("reads badges as the pages write them", () => {
    expect(badgeModes('---\nsidebar:\n  badge:\n    text: "13 modes + dial"\n---\n')).toBe(13);
    expect(badgeModes('---\nsidebar:\n  badge:\n    text: "1 mode"\n---\n')).toBe(1);
    expect(badgeModes('---\nsidebar:\n  badge:\n    text: "Elgato only"\n---\n')).toBeNull();
    expect(badgeModes("no frontmatter")).toBeNull();
    // Only the badge block's own text key is read, not another nested one.
    expect(badgeModes('---\nhero:\n  text: "9 modes"\nsidebar:\n  badge:\n    text: "3 modes"\n---\n')).toBe(3);
    expect(badgeModes('---\nhero:\n  text: "9 modes"\nsidebar:\n  label: x\n---\n')).toBeNull();
    expect(badgeModes('---\nsidebar:\n  badge:\n    variant: tip\n  other:\n    text: "4 modes"\n---\n')).toBeNull();
  });
});
