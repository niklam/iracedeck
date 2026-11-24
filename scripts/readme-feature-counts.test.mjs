import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  adjustOptions,
  badgeModes,
  checkFeatureCounts,
  keypadModeItem,
  keypadModeOptions,
  parseHomeStats,
  parseOverviewRows,
  parseReadmeRows,
  PLATFORM_GATED_OPTIONS,
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
 * Every number a control uses is read from the real tree, so adding an action
 * or a mode — with every summary updated — never turns a control red.
 */
const root = path.resolve(import.meta.dirname, "..");
const real = readFeatureCountInputs(root);

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

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const twoModeEjs =
  '<sdpi-item label="Mode"><sdpi-select><option value="a">A</option><option value="b">B</option></sdpi-select></sdpi-item>';

// The real numbers every control starts from.
const overviewRows = parseOverviewRows(real.overview);
const total = {
  actions: real.pages.length,
  modes: overviewRows.reduce((s, r) => s + r.modes, 0),
  categories: overviewRows.length,
};
/** A category other than Car Setup, and one of its pages whose badge states a count. */
const row = overviewRows.find(
  (r) => r.dir !== "car-setup" && real.pages.some((p) => p.category === r.dir && badgeModes(p.text) > 1),
);
const page = real.pages.find((p) => p.category === row.dir && badgeModes(p.text) > 1);
const pageModes = badgeModes(page.text);
/** A Car Setup page and its category row. */
const carPage = real.pages.find((p) => p.category === "car-setup");
const carRow = overviewRows.find((r) => r.dir === "car-setup");

/** The page's badge rewritten to `text`. */
const rebadge = (p, text) => replaceMatch(p.text, new RegExp(`text:\\s*"${pageModes} modes?[^"]*"`), `text: "${text}"`);

describe("feature counts (#1271)", () => {
  it("reads every input at all", () => {
    // Guards the parsers: empty results would make the clean check vacuous.
    expect(real.pages.length).toBeGreaterThan(30);
    expect(overviewRows.length).toBeGreaterThan(5);
    expect(parseReadmeRows(real.readme)).toHaveLength(overviewRows.length);
    expect(Object.keys(parseHomeStats(real.home))).toEqual(expect.arrayContaining(["Actions", "Modes", "Categories"]));
    expect(real.pages.filter((p) => p.category === "car-setup").every((p) => adjustOptions(p.ejs) > 0)).toBe(true);
    expect(real.pages.filter((p) => keypadModeOptions(p.ejs) > 1).length).toBeGreaterThan(25);
    expect(real.pages.filter((p) => badgeModes(p.text) > 1).length).toBeGreaterThan(25);
    expect(Object.keys(real.platformFeatures).length).toBeGreaterThan(0);
    expect(row && page && carPage && carRow).toBeTruthy();
  });

  it("finds the README and the website in line with the code", () => {
    expect(checkFeatureCounts(real)).toEqual([]);
  });

  // The controls break a copy of the real tree, so they only mean something
  // when that tree is clean. While it is not, the test above is already red and
  // names the drift; running them too would add a dozen failures that all say
  // the same thing. Skipping them never hides a break: it happens only on a
  // run that is red already.
  describe.skipIf(checkFeatureCounts(real).length > 0)("names each break (positive controls)", () => {
    it("a stale README headline, as #1271 found it", () => {
      const broken = withInput("readme", (t) => replaceOnce(t, `**${total.modes} modes**`, "**265+ modes**"));
      expect(checkFeatureCounts(broken)).toEqual([`README.md: states 265+ modes; the code has ${total.modes}`]);
    });

    it("a README headline with a wrong number", () => {
      const broken = withInput("readme", (t) =>
        replaceOnce(t, `**${total.modes} modes**`, `**${total.modes - 1} modes**`),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        `README.md: states ${total.modes - 1} modes; the code has ${total.modes}`,
      ]);
    });

    it("a README row with a wrong mode count", () => {
      const broken = withInput("readme", (t) =>
        replaceMatch(
          t,
          new RegExp(
            `^(\\|\\s*\\*\\*${escape(row.name)}\\*\\*\\s*\\|\\s*${row.actions}\\s*\\|\\s*)${row.modes}(\\s*\\|)`,
            "m",
          ),
          `$1${row.modes + 1}$2`,
        ),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        `README.md: "${row.name}" states ${row.actions} action${row.actions === 1 ? "" : "s"} / ${row.modes + 1} modes; the code has ${row.actions} / ${row.modes}`,
      ]);
    });

    it("a README table missing a category", () => {
      const first = overviewRows[0];
      const broken = withInput("readme", (t) =>
        replaceMatch(t, new RegExp(`^\\|\\s*\\*\\*${escape(first.name)}\\*\\*.*\\r?\\n`, "m"), ""),
      );
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        new RegExp(`README\\.md: Features table names \\[${escape(overviewRows[1].name)}`),
      );
    });

    it("an overview row whose mode count no longer matches its pages", () => {
      const broken = withInput("overview", (t) =>
        replaceMatch(
          t,
          new RegExp(
            `^(\\|\\s*\\[${escape(row.name)}\\]\\([^)]*\\)\\s*\\|\\s*${row.actions}\\s*\\|\\s*)${row.modes}(\\s*\\|)`,
            "m",
          ),
          `$1${row.modes - 1}$2`,
        ),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        `packages/website/src/content/docs/docs/actions/overview.md: "${row.name}" states ${row.modes - 1} modes; its actions count ${row.modes}`,
      ]);
    });

    it("a page whose badge gains a mode", () => {
      const [broken, p] = withPage(page.slug);
      p.text = rebadge(p, `${pageModes + 1} modes`);
      expect(checkFeatureCounts(broken)).toEqual([
        `${page.file}: its badge states ${pageModes + 1} modes; ${ACTIONS}/${page.slug}/${page.slug}.ejs offers ${pageModes}`,
      ]);
    });

    it("a template that gains a keypad Mode option, with nothing else updated", () => {
      const [broken, p] = withPage(page.slug);
      p.ejs = replaceMatch(
        p.ejs,
        /(<sdpi-item label="Mode">\s*<sdpi-select\b[^>]*>)/,
        '$1\n<option value="new-mode">New Mode</option>',
      );
      const out = checkFeatureCounts(broken).join("\n");
      expect(out).toContain(
        `${page.file}: its badge states ${pageModes} modes; ${ACTIONS}/${page.slug}/${page.slug}.ejs offers ${pageModes + 1}`,
      );
      expect(out).toMatch(
        new RegExp(
          `overview\\.md: "${escape(row.name)}" states ${row.modes} modes; its actions count ${row.modes + 1}`,
        ),
      );
      expect(out).toContain(`README.md: states ${total.modes} modes; the code has ${total.modes + 1}`);
    });

    it("a page with no mode count in its badge", () => {
      const [broken, p] = withPage(page.slug);
      p.text = rebadge(p, "New");
      expect(checkFeatureCounts(broken)).toEqual([
        `${page.file}: its sidebar badge names no mode count ("N modes"); add one, or list the page in SINGLE_MODE_PAGES`,
      ]);
    });

    it("a single-mode page whose template gains a Mode select", () => {
      const [broken, p] = withPage("switch-profile");
      p.ejs = twoModeEjs;
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        /switch-profile\.md: SINGLE_MODE_PAGES counts it as 1 mode; .* offers 2/,
      );
    });

    it("a page with no template", () => {
      const [broken, p] = withPage(page.slug);
      p.ejs = null;
      expect(checkFeatureCounts(broken).join("\n")).toContain(`${ACTIONS}/${page.slug}/${page.slug}.ejs: not found`);
    });

    it("one action with two pages", () => {
      const broken = structuredClone(real);
      broken.pages.push({ ...structuredClone(page), category: carPage.category, file: "copied.md" });
      expect(checkFeatureCounts(broken).join("\n")).toMatch(
        new RegExp(`action "${escape(page.slug)}" has more than one page \\(.*copied\\.md\\)`),
      );
    });

    it("an option the script removes, once the template drops it", () => {
      const [broken, p] = withPage("pit-crew");
      p.ejs = replaceMatch(p.ejs, /<option value="radar-volume"[^>]*>[^<]*<\/option>/, "");
      expect(checkFeatureCounts(broken)).toEqual([
        'RUNTIME_REMOVED_OPTIONS names "pit-crew" / "radar-volume", which its keypad Mode select no longer has; remove it',
      ]);
    });

    it("a platform-gated option whose flag the Stream Deck turns off", () => {
      const [slug, gates] = Object.entries(PLATFORM_GATED_OPTIONS)[0];
      const flag = Object.values(gates)[0];
      const broken = structuredClone(real);
      broken.platformFeatures[flag] = false;
      const gated = real.pages.find((p) => p.slug === slug);
      const badge = badgeModes(gated.text);
      expect(checkFeatureCounts(broken).join("\n")).toContain(
        `${gated.file}: its badge states ${badge} modes; ${ACTIONS}/${slug}/${slug}.ejs offers ${badge - 1}`,
      );
    });

    it("a new option inside an EJS if block", () => {
      const [broken, p] = withPage(page.slug);
      p.ejs = replaceMatch(
        p.ejs,
        /(<sdpi-item label="Mode">\s*<sdpi-select\b[^>]*>)/,
        '$1\n<% if (locals.platform?.features?.profiles !== false) { %><option value="new-mode">New</option><% } %>',
      );
      expect(checkFeatureCounts(broken).join("\n")).toContain(
        `${ACTIONS}/${page.slug}/${page.slug}.ejs: keypad Mode option "new-mode" is inside an EJS \`if\`; name the platform flag that gates it in PLATFORM_GATED_OPTIONS`,
      );
    });

    it("EJS control flow the count cannot read", () => {
      const [broken, p] = withPage(page.slug);
      p.ejs = replaceMatch(
        p.ejs,
        /(<sdpi-item label="Mode">\s*<sdpi-select\b[^>]*>)/,
        '$1\n<% for (const m of modes) { %><option value="<%= m %>"><%= m %></option><% } %>',
      );
      expect(checkFeatureCounts(broken).join("\n")).toMatch(/keypad Mode select has EJS control flow other than/);
    });

    it("a Car Setup template that gains an Adjust option", () => {
      const [broken, p] = withPage(carPage.slug);
      const carBadge = badgeModes(carPage.text);
      p.ejs = replaceMatch(p.ejs, /(<optgroup label="Adjust">)/, '$1\n<option value="new-adjust">New</option>');
      const out = checkFeatureCounts(broken).join("\n");
      expect(out).toContain(
        `${carPage.file}: its badge states ${carBadge} modes; ${ACTIONS}/${carPage.slug}/${carPage.slug}.ejs offers ${carBadge + 1}`,
      );
      expect(out).toMatch(
        new RegExp(
          `overview\\.md: "${escape(carRow.name)}" states ${carRow.modes} modes; its actions count ${carRow.modes + 1}`,
        ),
      );
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
        file: "new-action.md",
        text: '---\nsidebar:\n  badge:\n    text: "2 modes"\n---\n',
        ejs: twoModeEjs,
      });
      broken.manifest.Actions.push({ UUID: "com.iracedeck.sd.core.new-action" });
      const out = checkFeatureCounts(broken).join("\n");
      expect(out).toMatch(/overview\.md: no category row links to \/docs\/actions\/new-category\//);
      expect(out).toContain(`README.md: states ${total.actions} actions; the code has ${total.actions + 1}`);
      expect(out).toContain(`README.md: states ${total.categories} categories; the code has ${total.categories + 1}`);
    });

    it("a stale docs landing page", () => {
      const broken = withInput("docsIndex", (t) =>
        replaceOnce(t, `**${total.modes} modes**`, `**${total.modes - 10} modes**`),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        `packages/website/src/content/docs/docs/index.md: states ${total.modes - 10} modes; the code has ${total.modes}`,
      ]);
    });

    it("a stale home-page stat", () => {
      const broken = withInput("home", (t) =>
        replaceOnce(
          t,
          `<span class="stat-value">${total.modes}</span>`,
          `<span class="stat-value">${total.modes - 10}</span>`,
        ),
      );
      expect(checkFeatureCounts(broken)).toEqual([
        `packages/website/src/content/docs/index.mdx: states ${total.modes - 10} modes; the code has ${total.modes}`,
      ]);
    });
  });

  it("counts only the options a user can pick", () => {
    const ejs =
      '<sdpi-item label="Mode"><sdpi-select><option value="a">A</option><!-- <option value="b">B</option> -->' +
      '<option value="c" hidden>C</option><optgroup label="Old" hidden><option value="e">E</option></optgroup>' +
      '<option value="d">D</option></sdpi-select></sdpi-item>';
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

  it("finds the keypad's Mode item, not a commented-out or dial one", () => {
    const live = '<sdpi-item label="Mode"><option value="live">L</option></sdpi-item>';
    const old = '<sdpi-item label="Mode"><option value="x">X</option><option value="y">Y</option></sdpi-item>';
    expect(keypadModeItem(`<!-- ${old} -->${live}`)).toContain('value="live"');
    expect(keypadModeItem(`<%# ${old} %>${live}`)).toContain('value="live"');
    // A keypad section with no Mode select: the dial's is not the keypad's.
    expect(keypadModeItem(`<div id="keypad-settings"></div><div id="dial-settings">${old}</div>`)).toBeNull();
    expect(keypadModeItem(`<div id="keypad-settings">${live}</div><div id="dial-settings">${old}</div>`)).toContain(
      'value="live"',
    );
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
