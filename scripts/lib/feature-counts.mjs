import fs from "node:fs";
import path from "node:path";

/**
 * The feature counts every public summary states — actions, modes and
 * categories — checked against the code that registers them (#1271).
 *
 * The counts are written by hand in four places: the root `README.md`, the
 * website's Actions Overview (`docs/actions/overview.md`), the docs landing
 * page (`docs/index.md`) and the home page's stat row (`index.mdx`). Nothing
 * connected them, and the README fell behind: it said "265+ modes" while its
 * own table summed to 287.
 *
 * The chain this checks, from the code outwards:
 *
 * 1. The Stream Deck manifest's visible actions (`VisibleInActionsList` not
 *    `false`; the four hidden ones are legacy replay and camera actions kept
 *    working for old keys) are exactly the action pages under
 *    `docs/actions/<category>/<action>.md`, by name.
 * 2. Each page's mode badge (`"7 modes"`, `"13 modes + dial"`) states the
 *    options its action's keypad Mode select offers in the action's `.ejs`:
 *    an option marked `hidden`, inside a comment, or named in
 *    `RUNTIME_REMOVED_OPTIONS` is not one. A template with no Mode select is a
 *    single-mode action, whose badge says `1 mode` or which
 *    `SINGLE_MODE_PAGES` names.
 * 3. Each category's modes are the sum of its pages' modes, except that Car
 *    Setup counts only the options of each action's `Adjust` optgroup,
 *    leaving out the "Display value" sub-modes its badges include — the
 *    convention the `iracedeck-actions` skill documents.
 * 4. The overview's table has one row per category folder, with that folder's
 *    page count and mode count, and its headline states their sums.
 * 5. The README's headline and Features table, the docs landing page's
 *    headline and the home page's stats state the same numbers, and the
 *    README's table names the overview's categories in the overview's order.
 *
 * Every problem is returned as one line naming the file and both numbers, so a
 * red run says what to change without re-deriving anything.
 */

/** Paths, relative to the repository root, of every file the check reads. */
export const FEATURE_COUNT_PATHS = {
  readme: "README.md",
  overview: "packages/website/src/content/docs/docs/actions/overview.md",
  docsIndex: "packages/website/src/content/docs/docs/index.md",
  home: "packages/website/src/content/docs/index.mdx",
  actionPages: "packages/website/src/content/docs/docs/actions",
  manifest: "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json",
  actions: "packages/iracing-actions/src/actions",
};

/** The category whose modes are counted from its `.ejs` `Adjust` optgroups. */
export const ADJUST_ONLY_CATEGORY = "car-setup";

/**
 * Action pages whose badge names no mode count and which count as one mode.
 * Switch Profile's badge says "Elgato only", the fact a reader needs more than
 * a count of one. A page missing from here with no `N modes` badge is a
 * problem, so a new page cannot be counted silently.
 */
export const SINGLE_MODE_PAGES = new Set(["stream-deck/switch-profile"]);

/**
 * Keypad Mode options a template still carries but its script removes from the
 * dropdown for a new key, by action. Each is kept only so an existing key that
 * uses it keeps working, so it is not a mode a user can pick.
 *
 * - `pit-crew` / `radar-volume`: moved to Audio Controls (#590).
 *
 * @type {Record<string, string[]>}
 */
export const RUNTIME_REMOVED_OPTIONS = { "pit-crew": ["radar-volume"] };

/**
 * Reads every input the check needs from a repository checkout.
 *
 * @param {string} root the repository root
 */
export function readFeatureCountInputs(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const pagesDir = path.join(root, FEATURE_COUNT_PATHS.actionPages);
  const pages = [];
  for (const category of fs.readdirSync(pagesDir).sort()) {
    const dir = path.join(pagesDir, category);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/\.mdx?$/.test(file)) continue;
      const slug = file.replace(/\.mdx?$/, "");
      const ejs = path.join(FEATURE_COUNT_PATHS.actions, slug, `${slug}.ejs`);
      pages.push({
        category,
        slug,
        text: read(path.join(FEATURE_COUNT_PATHS.actionPages, category, file)),
        ejs: fs.existsSync(path.join(root, ejs)) ? read(ejs) : null,
      });
    }
  }
  return {
    readme: read(FEATURE_COUNT_PATHS.readme),
    overview: read(FEATURE_COUNT_PATHS.overview),
    docsIndex: read(FEATURE_COUNT_PATHS.docsIndex),
    home: read(FEATURE_COUNT_PATHS.home),
    manifest: JSON.parse(read(FEATURE_COUNT_PATHS.manifest)),
    pages,
  };
}

/**
 * The mode count a page's sidebar badge states, or `null` when it names none.
 * Only the `text` key inside the frontmatter's `badge:` block is read.
 */
export function badgeModes(pageText) {
  const frontmatter = pageText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const lines = frontmatter[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*badge:\s*$/.test(line));
  if (at < 0) return null;
  const indent = lines[at].match(/^\s*/)[0].length;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const text = line.match(/^\s+text:\s*"([^"]*)"/);
    if (text) {
      const count = text[1].match(/^(\d+) modes?\b/);
      return count ? Number(count[1]) : null;
    }
  }
  return null;
}

/**
 * The template's first `<sdpi-item label="Mode">` — the keypad one; a dial
 * section's Mode select comes after it — with HTML comments removed. `null`
 * when the template has none, or never closes it.
 */
function keypadModeItem(ejs) {
  const start = ejs.indexOf('<sdpi-item label="Mode">');
  if (start < 0) return null;
  const end = ejs.indexOf("</sdpi-item>", start);
  if (end < 0) return null;
  return ejs.slice(start, end).replace(/<!--[\s\S]*?-->/g, "");
}

/** The `value` of every option in some template text not marked `hidden`. */
function visibleOptionValues(text) {
  return [...text.matchAll(/<option\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !/\shidden\b/.test(tag))
    .map((tag) => tag.match(/\svalue="([^"]*)"/)?.[1] ?? "");
}

/**
 * The options the keypad Mode select offers a new key: not `hidden`, not in a
 * comment, and not one the template's script removes. `null` when the
 * template has no keypad Mode select.
 *
 * @param {string} ejs
 * @param {string[]} [removed] option values the template's script removes
 */
export function keypadModeOptions(ejs, removed = []) {
  const item = keypadModeItem(ejs);
  if (item == null) return null;
  return visibleOptionValues(item).filter((value) => !removed.includes(value)).length;
}

/**
 * The options a user can pick inside the `Adjust` optgroup of the keypad Mode
 * select. `null` when the template has no such optgroup.
 */
export function adjustOptions(ejs) {
  const group = keypadModeItem(ejs)?.match(/<optgroup label="Adjust">([\s\S]*?)<\/optgroup>/);
  return group ? visibleOptionValues(group[1]).length : null;
}

const num = (s) => Number(s.trim());

/**
 * `{ actions, modes, categories }` from "N actions with M modes … K categories",
 * each as the text the file writes. A count is compared as that text, so a
 * vague "265+" is named as stated rather than read as a number.
 */
function parseHeadline(text, pattern) {
  const m = text.match(pattern);
  return m ? { actions: m[1], modes: m[2], categories: m[3] } : null;
}

/** A headline count: digits, optionally followed by `+` so a vague one is still found and named. */
const COUNT = String.raw`(\d+\+?)`;

/** The overview's category rows: `{ name, dir, actions, modes }`. */
export function parseOverviewRows(overview) {
  const rows = [];
  for (const m of overview.matchAll(
    /^\|\s*\[([^\]]+)\]\(\/docs\/actions\/([a-z0-9-]+)\/[^)]*\)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm,
  )) {
    rows.push({ name: m[1], dir: m[2], actions: num(m[3]), modes: num(m[4]) });
  }
  return rows;
}

/** The README Features table's rows: `{ name, actions, modes }`. */
export function parseReadmeRows(readme) {
  const section = readme.match(/^## Features\r?\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  const rows = [];
  for (const m of section.matchAll(/^\|\s*\*\*([^*]+)\*\*\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm)) {
    rows.push({ name: m[1].trim(), actions: num(m[2]), modes: num(m[3]) });
  }
  return rows;
}

/** The home page's stat row: `{ Actions: "33", Modes: "287", … }`. */
export function parseHomeStats(home) {
  const stats = {};
  for (const m of home.matchAll(
    /<span class="stat-value">([^<]*)<\/span>\s*<span class="stat-label">([^<]*)<\/span>/g,
  )) {
    stats[m[2].trim()] = m[1].trim();
  }
  return stats;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Every disagreement between the code and the stated counts, one line each.
 * An empty array means every summary is in line.
 *
 * @param {ReturnType<typeof readFeatureCountInputs>} inputs
 * @returns {string[]}
 */
export function checkFeatureCounts(inputs) {
  const problems = [];
  const P = FEATURE_COUNT_PATHS;

  // 1. Visible manifest actions vs action pages.
  const visible = inputs.manifest.Actions.filter((a) => a.VisibleInActionsList !== false).map((a) =>
    a.UUID.split(".").pop(),
  );
  const pageSlugs = inputs.pages.map((p) => p.slug);
  for (const slug of visible.filter((s) => !pageSlugs.includes(s))) {
    problems.push(`${P.manifest}: visible action "${slug}" has no page under ${P.actionPages}/<category>/`);
  }
  for (const slug of pageSlugs.filter((s) => !visible.includes(s))) {
    problems.push(`${P.actionPages}: page "${slug}" is not a visible action in ${P.manifest}`);
  }

  // 2. Each page's badge against its action's template.
  /** @type {Map<string, { actions: number, modes: number }>} */
  const byCategory = new Map();
  for (const page of inputs.pages) {
    const id = `${page.category}/${page.slug}`;
    const pageFile = `${P.actionPages}/${id}.md`;
    const ejsFile = `${P.actions}/${page.slug}/${page.slug}.ejs`;
    // Counted as an action whatever else is wrong with it, so one bad page is
    // not also reported as a wrong action count for its category.
    const entry = byCategory.get(page.category) ?? { actions: 0, modes: 0 };
    entry.actions += 1;
    byCategory.set(page.category, entry);
    if (page.ejs == null) {
      problems.push(`${ejsFile}: not found; every action page needs its action's template`);
      continue;
    }
    const removed = RUNTIME_REMOVED_OPTIONS[page.slug] ?? [];
    const present = visibleOptionValues(keypadModeItem(page.ejs) ?? "");
    for (const value of removed.filter((v) => !present.includes(v))) {
      problems.push(
        `RUNTIME_REMOVED_OPTIONS names "${page.slug}" / "${value}", which its keypad Mode select no longer has; remove it`,
      );
    }
    // A badge that disagrees is reported, but the template's count still goes
    // into the category: it is the code, so the totals stay right and the red
    // run names only the badge.
    const offered = keypadModeOptions(page.ejs, removed) ?? 1;
    const badge = badgeModes(page.text);
    if (badge == null && !SINGLE_MODE_PAGES.has(id)) {
      problems.push(
        `${pageFile}: its sidebar badge names no mode count ("N modes"); add one, or list the page in SINGLE_MODE_PAGES`,
      );
    } else if (badge == null && offered !== 1) {
      problems.push(`${pageFile}: SINGLE_MODE_PAGES counts it as 1 mode; ${ejsFile} offers ${offered}`);
    } else if (badge != null && badge !== offered) {
      problems.push(`${pageFile}: its badge states ${plural(badge, "mode")}; ${ejsFile} offers ${offered}`);
    }

    // 3. The category's count: Car Setup counts only its Adjust options.
    if (page.category === ADJUST_ONLY_CATEGORY) {
      const adjust = adjustOptions(page.ejs);
      if (adjust == null) {
        problems.push(`${ejsFile}: no "Adjust" optgroup in its keypad Mode select`);
        continue;
      }
      entry.modes += adjust;
    } else {
      entry.modes += offered;
    }
  }
  for (const id of SINGLE_MODE_PAGES) {
    if (!inputs.pages.some((p) => `${p.category}/${p.slug}` === id)) {
      problems.push(`SINGLE_MODE_PAGES names "${id}", which has no page; remove it`);
    }
  }
  for (const slug of Object.keys(RUNTIME_REMOVED_OPTIONS)) {
    if (!inputs.pages.some((p) => p.slug === slug)) {
      problems.push(`RUNTIME_REMOVED_OPTIONS names "${slug}", which has no page; remove it`);
    }
  }

  // 4. The overview against the pages.
  const overviewRows = parseOverviewRows(inputs.overview);
  const overviewHead = parseHeadline(
    inputs.overview,
    new RegExp(`provides ${COUNT} actions with ${COUNT} modes for iRacing, organized into ${COUNT} categories`),
  );
  if (!overviewHead)
    problems.push(`${P.overview}: headline "provides N actions with M modes … K categories" not found`);
  const rowDirs = overviewRows.map((r) => r.dir);
  for (const dir of byCategory.keys()) {
    if (!rowDirs.includes(dir)) problems.push(`${P.overview}: no category row links to /docs/actions/${dir}/`);
  }
  for (const row of overviewRows) {
    if (rowDirs.filter((d) => d === row.dir).length > 1) {
      problems.push(`${P.overview}: more than one row links to /docs/actions/${row.dir}/`);
    }
    const counted = byCategory.get(row.dir);
    if (!counted) {
      problems.push(`${P.overview}: row "${row.name}" links to /docs/actions/${row.dir}/, which has no action pages`);
      continue;
    }
    if (row.actions !== counted.actions) {
      problems.push(
        `${P.overview}: "${row.name}" states ${plural(row.actions, "action")}; ${row.dir}/ has ${counted.actions} pages`,
      );
    }
    if (row.modes !== counted.modes) {
      problems.push(
        `${P.overview}: "${row.name}" states ${plural(row.modes, "mode")}; its actions count ${counted.modes}`,
      );
    }
  }
  const total = {
    actions: [...byCategory.values()].reduce((s, c) => s + c.actions, 0),
    modes: [...byCategory.values()].reduce((s, c) => s + c.modes, 0),
    categories: byCategory.size,
  };

  // 5. Every other summary against the code-derived totals and the overview's rows.
  const checkHeadline = (file, head, label) => {
    if (!head) {
      problems.push(`${file}: ${label} not found`);
      return;
    }
    for (const key of /** @type {const} */ (["actions", "modes", "categories"])) {
      if (head[key].trim() !== String(total[key])) {
        problems.push(`${file}: states ${head[key].trim()} ${key}; the code has ${total[key]}`);
      }
    }
  };
  const boldHeadline = new RegExp(
    `\\*\\*${COUNT} actions\\*\\* with \\*\\*${COUNT} modes\\*\\* across ${COUNT} categories`,
  );
  if (overviewHead) checkHeadline(P.overview, overviewHead, "headline");
  checkHeadline(
    P.readme,
    parseHeadline(inputs.readme, boldHeadline),
    'Features headline "**N actions** with **M modes** across K categories"',
  );
  checkHeadline(
    P.docsIndex,
    parseHeadline(inputs.docsIndex, boldHeadline),
    'headline "**N actions** with **M modes** across K categories"',
  );
  const stats = parseHomeStats(inputs.home);
  checkHeadline(
    P.home,
    "Actions" in stats && "Modes" in stats && "Categories" in stats
      ? { actions: stats.Actions, modes: stats.Modes, categories: stats.Categories }
      : null,
    "stat values for Actions, Modes and Categories",
  );

  const readmeRows = parseReadmeRows(inputs.readme);
  const names = (rows) => rows.map((r) => r.name).join(", ");
  if (names(readmeRows) !== names(overviewRows)) {
    problems.push(
      `${P.readme}: Features table names [${names(readmeRows)}]; the overview names [${names(overviewRows)}], in that order`,
    );
  }
  // A README row is held to the code's count for the folder its namesake
  // overview row links to, so a wrong overview row is not blamed on it too.
  for (const row of readmeRows) {
    const dir = overviewRows.find((r) => r.name === row.name)?.dir;
    const counted = dir && byCategory.get(dir);
    if (!counted) continue;
    if (row.actions !== counted.actions || row.modes !== counted.modes) {
      problems.push(
        `${P.readme}: "${row.name}" states ${plural(row.actions, "action")} / ${plural(row.modes, "mode")}; the code has ${counted.actions} / ${counted.modes}`,
      );
    }
  }

  return problems;
}
