import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import { CHANGELOG_CATEGORIES, ChangelogParseError, parseChangelog } from "./changelog-parse.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REAL_CHANGELOG = path.resolve(__dirname, "../../packages/website/src/content/docs/changelog.mdx");

/** The MDX preamble every real changelog carries, which the parser must skip. */
const PREAMBLE = `---
title: Changelog
description: Release notes.
---

import ChangelogLeadIn from "../../components/ChangelogLeadIn.astro";

<ChangelogLeadIn />

Release notes for each version of iRaceDeck. The newest release is listed first.

`;

describe("parseChangelog", () => {
  it("skips the frontmatter, the import, the component and the intro prose", () => {
    const { releases } = parseChangelog(`${PREAMBLE}## 1.2.3

_2026-01-02_

**Features**

- Something new.
`);

    expect(releases).toHaveLength(1);
    expect(releases[0].version).toBe("1.2.3");
  });

  it("reads the version, the date and the categories of each release, newest first", () => {
    const { releases } = parseChangelog(`## 2.0.0

_2026-02-03_

**Features**

- First feature.
- Second feature.

**Bug Fixes**

- A fix.

## 1.9.0

_2025-12-24_

**Maintenance**

- Housekeeping.
`);

    expect(releases).toEqual([
      {
        version: "2.0.0",
        date: "2026-02-03",
        categories: [
          { title: "Features", items: ["First feature.", "Second feature."] },
          { title: "Bug Fixes", items: ["A fix."] },
        ],
      },
      {
        version: "1.9.0",
        date: "2025-12-24",
        categories: [{ title: "Maintenance", items: ["Housekeeping."] }],
      },
    ]);
  });

  it("reports an in-development release as undated rather than inventing a date", () => {
    const { releases } = parseChangelog(`## 3.0.0

_Unreleased_

**Features**

- Not out yet.
`);

    expect(releases[0].date).toBeNull();
  });

  it("tolerates a release with no date line at all", () => {
    // `## 0.13.0` in the real changelog predates the date convention.
    const { releases } = parseChangelog(`## 0.13.0

**Features**

- An ancient feature.
`);

    expect(releases[0]).toEqual({
      version: "0.13.0",
      date: null,
      categories: [{ title: "Features", items: ["An ancient feature."] }],
    });
  });

  it("keeps bullet text verbatim, including inline MDX literals", () => {
    const { releases } = parseChangelog(`## 1.0.0

_2026-01-01_

**Improvements**

- Wraps \`<name>\` in backticks and **bolds** the rest.
`);

    expect(releases[0].categories[0].items[0]).toBe(
      "Wraps `<name>` in backticks and **bolds** the rest.",
    );
  });

  it("accepts CRLF line endings", () => {
    const { releases } = parseChangelog("## 1.0.0\r\n\r\n_2026-01-01_\r\n\r\n**Features**\r\n\r\n- A thing.\r\n");

    expect(releases).toEqual([
      { version: "1.0.0", date: "2026-01-01", categories: [{ title: "Features", items: ["A thing."] }] },
    ]);
  });

  describe("rejects a section it cannot render, rather than silently dropping it", () => {
    it("throws on an unknown category header", () => {
      expect(() =>
        parseChangelog(`## 1.0.0

_2026-01-01_

**Fixes**

- Miscategorised.
`),
      ).toThrow(/Unknown category "Fixes"/);
    });

    it("throws on categories out of the documented order", () => {
      expect(() =>
        parseChangelog(`## 1.0.0

_2026-01-01_

**Bug Fixes**

- A fix.

**Features**

- A feature.
`),
      ).toThrow(/out of order/);
    });

    it("throws on a repeated category within one release", () => {
      expect(() =>
        parseChangelog(`## 1.0.0

_2026-01-01_

**Features**

- One.

**Features**

- Two.
`),
      ).toThrow(/appears twice/);
    });

    it("throws on a bullet that precedes any category", () => {
      expect(() =>
        parseChangelog(`## 1.0.0

_2026-01-01_

- Homeless bullet.
`),
      ).toThrow(/before any category/);
    });

    it("throws on a heading that is not a plain version number", () => {
      expect(() => parseChangelog("## 1.0.0 (beta)\n")).toThrow(/not a version number/);
    });

    it("throws on a duplicated version heading", () => {
      expect(() =>
        parseChangelog(`## 1.0.0

_2026-01-01_

**Features**

- One.

## 1.0.0

_2026-01-02_

**Features**

- Again.
`),
      ).toThrow(/appears twice/);
    });

    it("throws on prose the renderer has nowhere to put", () => {
      expect(() =>
        parseChangelog(`## 1.0.0

_2026-01-01_

**Features**

- A bullet.

Some trailing prose.
`),
      ).toThrow(/Unrecognised line/);
    });

    it("names the line number so the offending entry can be found", () => {
      let error;
      try {
        parseChangelog("## 1.0.0\n\n_2026-01-01_\n\n### Nope\n");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ChangelogParseError);
      expect(error.message).toContain("line 5");
    });
  });

  describe("the real changelog", () => {
    // The pane is generated from this file, so a malformed entry would drop a
    // whole release from what users see. This is the guard that catches it.
    const source = readFileSync(REAL_CHANGELOG, "utf-8");

    it("parses end to end", () => {
      const { releases } = parseChangelog(source);

      expect(releases.length).toBe((source.match(/^## /gm) ?? []).length);
      expect(releases.length).toBeGreaterThan(30);
    });

    it("gives every release at least one category with at least one bullet", () => {
      const { releases } = parseChangelog(source);

      for (const release of releases) {
        expect(release.categories.length, `${release.version} has no categories`).toBeGreaterThan(0);
        for (const category of release.categories) {
          expect(category.items.length, `${release.version} / ${category.title} is empty`).toBeGreaterThan(0);
          expect(CHANGELOG_CATEGORIES).toContain(category.title);
        }
      }
    });

    it("dates every released version, leaving only the in-development one undated", () => {
      const { releases } = parseChangelog(source);
      const undated = releases.filter((r) => r.date === null).map((r) => r.version);

      // The in-development section plus `0.13.0`, which predates the convention.
      expect(undated.length).toBeLessThanOrEqual(2);
    });
  });
});
