import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildComposedChangelogData, readComposedChangelog } from "./changelog-composed.mjs";
import { buildChangelogData, CHANGELOG_SOURCE_PATH } from "./changelog-data.mjs";
import { CHANGELOG_FRAGMENTS_DIR, loadChangelogSources } from "./changelog-fragments.mjs";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

const PREAMBLE = `---
title: Changelog
---

Release notes.

`;

const DATED = `## 1.2.0

_2026-01-05_

**Bug Fixes**

- An older fix.
`;

const fragment = (category, weight, body) => `---\ncategory: ${category}\nweight: ${weight}\n---\n\n${body}\n`;

describe("readComposedChangelog / buildComposedChangelogData", () => {
  let root;

  const write = (relative, text) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "changelog-composed-"));
    write(CHANGELOG_SOURCE_PATH, `${PREAMBLE}${DATED}`);
    write("package.json", JSON.stringify({ version: "1.3.0-dev.0" }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/README.md`, "# Fragments\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("composes the fragments as the Unreleased release of the stripped package version", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-a-fix.md`, fragment("Bug Fixes", 50, "A new fix."));
    write(`${CHANGELOG_FRAGMENTS_DIR}/9-a-feature.md`, fragment("Features", 50, "A **new** feature."));

    const data = buildComposedChangelogData(root);

    expect(data.releases.map((r) => [r.version, r.date])).toEqual([
      ["1.3.0", null],
      ["1.2.0", "2026-01-05"],
    ]);
    expect(data.releases[0].categories).toEqual([
      { title: "Features", items: ["A <strong>new</strong> feature."] },
      { title: "Bug Fixes", items: ["A new fix."] },
    ]);
    expect(readComposedChangelog(root)).toContain("## 1.3.0\n\n_Unreleased_\n");
  });

  it("returns the MDX unchanged, and builds exactly its data, with no fragments", () => {
    expect(readComposedChangelog(root)).toBe(`${PREAMBLE}${DATED}`);
    expect(buildComposedChangelogData(root)).toEqual(buildChangelogData(`${PREAMBLE}${DATED}`));
  });

  it("refuses a hand-written in-development section even with no fragments", () => {
    write(CHANGELOG_SOURCE_PATH, `${PREAMBLE}## 1.3.0\n\n_Unreleased_\n\n**Features**\n\n- Old habit.\n\n${DATED}`);

    expect(() => buildComposedChangelogData(root)).toThrow(/_Unreleased_/);
  });

  it("refuses a malformed fragment rather than dropping it", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-bad.md`, fragment("Bugfixes", 50, "Typo in the category."));

    expect(() => buildComposedChangelogData(root)).toThrow(/7-bad\.md/);
  });

  it("composes the real tree, with one release per section plus the fragments' own", () => {
    const { mdx, fragments } = loadChangelogSources(REPO_ROOT);
    const data = buildComposedChangelogData(REPO_ROOT);
    const dated = (mdx.match(/^## /gm) ?? []).length;

    expect(data.releases).toHaveLength(dated + (fragments.length > 0 ? 1 : 0));
  });
});
