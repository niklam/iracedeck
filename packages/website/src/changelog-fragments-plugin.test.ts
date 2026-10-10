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

  it("renders the real fragments as renderReleaseSection writes them", () => {
    const { fragments, version } = loadChangelogSources(REPO_ROOT);

    expect(changelogFragmentSection(REPO_ROOT)).toBe(
      fragments.length === 0 ? null : renderReleaseSection(version, UNRELEASED_DATE_LINE, fragments),
    );
  });
});
