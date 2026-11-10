import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { markdownToHtml } from "satteri";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHANGELOG_SOURCE_PATH } from "../../../scripts/lib/changelog-data.mjs";
import {
  CHANGELOG_FRAGMENTS_DIR,
  loadChangelogSources,
  renderReleaseSection,
  UNRELEASED_DATE_LINE,
} from "../../../scripts/lib/changelog-fragments.mjs";
import { UNRELEASED_LABEL } from "../../../scripts/lib/changelog-parse.mjs";
import { changelogFragmentSection, changelogFragmentsPlugin } from "./changelog-fragments-plugin.mjs";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");

const INTRO = "Release notes.\n\n";

const DATED = `## 1.2.0

_2026-01-05_

**Bug Fixes**

- An older fix.
`;

const PAGE = `${INTRO}${DATED}`;

const fragment = (category: string, weight: number, body: string) =>
  `---\ncategory: ${category}\nweight: ${weight}\n---\n\n${body}\n`;

describe("changelogFragmentsPlugin", () => {
  let root: string;

  const write = (relative: string, text: string) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  /** Renders `PAGE` through Sätteri with the plugin, as if it were the file at `relative`. */
  const render = (relative = CHANGELOG_SOURCE_PATH) =>
    markdownToHtml(PAGE, {
      mdastPlugins: [changelogFragmentsPlugin({ root })],
      fileURL: url.pathToFileURL(path.join(root, relative)),
    }).html;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "changelog-fragments-plugin-"));
    write(CHANGELOG_SOURCE_PATH, PAGE);
    write("package.json", JSON.stringify({ version: "1.3.0-dev.0" }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/README.md`, "# Fragments\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders the page as if renderReleaseSection's text were written before the first ## heading", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-a-fix.md`, fragment("Bug Fixes", 50, "A new fix."));
    write(`${CHANGELOG_FRAGMENTS_DIR}/9-a-feature.md`, fragment("Features", 50, "A **new** feature with `{x}`."));
    const { fragments } = loadChangelogSources(root);
    const handWritten = `${INTRO}${renderReleaseSection("1.3.0", UNRELEASED_DATE_LINE, fragments)}\n${DATED}`;

    const html = render();

    expect(html).toBe(markdownToHtml(handWritten).html);
    expect(html.indexOf("<h2>1.3.0</h2>")).toBeGreaterThan(html.indexOf("Release notes."));
    expect(html.indexOf("<h2>1.3.0</h2>")).toBeLessThan(html.indexOf("<h2>1.2.0</h2>"));
  });

  it("leaves every other page untouched", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-a-fix.md`, fragment("Bug Fixes", 50, "A new fix."));

    expect(render("packages/website/src/content/docs/docs/index.md")).toBe(markdownToHtml(PAGE).html);
  });

  it("leaves the page untouched when there are no fragments", () => {
    expect(render()).toBe(markdownToHtml(PAGE).html);
  });

  it("fails the build on a malformed fragment, naming it", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-bad.md`, fragment("Bugfixes", 50, "Typo in the category."));

    expect(() => render()).toThrow(/7-bad\.md/);
  });

  it("fails the build on a fragment that repeats a dated bullet, as the generator does", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-again.md`, fragment("Bug Fixes", 50, "An older fix."));

    expect(() => render()).toThrow(/already in a released section/);
  });

  it("fails the build on a pre-release of the newest dated version while fragments exist (#1398)", () => {
    write("package.json", JSON.stringify({ version: "1.2.0-dev.0" }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/9-a-feature.md`, fragment("Features", 50, "Merged after the fold."));

    expect(() => render()).toThrow(/1\.2\.0-dev\.0 \(package\.json\) is a pre-release of "## 1\.2\.0".*next -dev/);
    expect(() => changelogFragmentSection(root)).toThrow(/is a pre-release of "## 1\.2\.0"/);
  });

  it("renders the window's fragments as an Unreleased section above the version's dated one (#1398)", () => {
    write("package.json", JSON.stringify({ version: "1.2.0" }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/9-a-feature.md`, fragment("Features", 50, "Merged after the fold."));

    const html = render();

    const { fragments } = loadChangelogSources(root);
    const handWritten = `${INTRO}${renderReleaseSection(UNRELEASED_LABEL, null, fragments)}\n${DATED}`;
    expect(html).toBe(markdownToHtml(handWritten).html);
    expect(html.indexOf(`<h2>${UNRELEASED_LABEL}</h2>`)).toBeGreaterThan(html.indexOf("Release notes."));
    expect(html.indexOf(`<h2>${UNRELEASED_LABEL}</h2>`)).toBeLessThan(html.indexOf("<h2>1.2.0</h2>"));
    // No `_Unreleased_` date line under the heading: the word appears once.
    expect(html).not.toContain("<em>Unreleased</em>");
    expect(html.match(/Unreleased/g)).toHaveLength(1);
    expect(changelogFragmentSection(root)).toBe(`## ${UNRELEASED_LABEL}\n\n**Features**\n\n- Merged after the fold.\n`);
  });

  it("renders the real fragments as renderReleaseSection writes them", () => {
    const { mdx, fragments, version } = loadChangelogSources(REPO_ROOT);
    // Inside the window after a stable fold the root version is exactly the
    // newest dated one, and the fragments render as the Unreleased section
    // instead; otherwise under the root version without its pre-release suffix.
    const newest = /^##[ \t]+(.*?)[ \t]*$/m.exec(mdx)?.[1];
    const expected = () =>
      newest === version
        ? renderReleaseSection(UNRELEASED_LABEL, null, fragments)
        : renderReleaseSection(version.replace(/-.*$/, ""), UNRELEASED_DATE_LINE, fragments);

    expect(changelogFragmentSection(REPO_ROOT)).toBe(fragments.length === 0 ? null : expected());
  });
});
