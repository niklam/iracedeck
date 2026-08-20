import { describe, expect, it } from "vitest";

import { buildChangelogData, serializeChangelogData } from "./changelog-data.mjs";

const SOURCE = `---
title: Changelog
---

import ChangelogLeadIn from "../../components/ChangelogLeadIn.astro";

<ChangelogLeadIn />

Release notes for each version of iRaceDeck.

## 2.0.0

_Unreleased_

**Features**

- A **bold** claim about \`code\`.

## 1.9.0

_2026-01-05_

**Bug Fixes**

- Fixed the [dials](/docs/features/dials/) page link.
`;

describe("buildChangelogData", () => {
  it("keeps releases newest first, with their version and date", () => {
    const { releases } = buildChangelogData(SOURCE);

    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ["2.0.0", null],
      ["1.9.0", "2026-01-05"],
    ]);
  });

  it("renders each bullet to HTML so the pane never parses markdown at runtime", () => {
    const { releases } = buildChangelogData(SOURCE);

    expect(releases[0].categories).toEqual([
      { title: "Features", items: ["A <strong>bold</strong> claim about <code>code</code>."] },
    ]);
  });

  it("absolutises website links, which would otherwise point at the plugin's own server", () => {
    const { releases } = buildChangelogData(SOURCE);

    expect(releases[1].categories[0].items[0]).toContain('href="https://iracedeck.com/docs/features/dials/"');
  });

  it("names the release and the bullet when one cannot be rendered", () => {
    // The renderer sees a bullet with no idea where it came from, so a bare
    // "must start with /" would send the author hunting through 700 lines.
    const broken = SOURCE.replace("- Fixed the [dials]", "- Fixed the [dials](docs/relative.html) [broken]");

    expect(() => buildChangelogData(broken)).toThrow(/1\.9\.0 \/ Bug Fixes/);
    expect(() => buildChangelogData(broken)).toThrow(/bullet: Fixed the \[dials\]/);
  });

  it("records where the artifact came from, so nobody hand-edits it", () => {
    const { _meta } = buildChangelogData(SOURCE);

    expect(_meta.generatedFrom).toBe("packages/website/src/content/docs/changelog.mdx");
    expect(_meta.generatedBy).toBe("pnpm generate:changelog-data");
  });
});

describe("serializeChangelogData", () => {
  it("emits two-space JSON with a trailing newline, as Prettier expects of a committed JSON file", () => {
    const text = serializeChangelogData({ _meta: {}, releases: [] });

    expect(text).toBe('{\n  "_meta": {},\n  "releases": []\n}\n');
  });
});
