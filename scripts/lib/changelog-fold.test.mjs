import { describe, expect, it } from "vitest";

import { formatLocalDate, planChangelogFold } from "./changelog-fold.mjs";
import { parseFragment } from "./changelog-fragments.mjs";

const MDX = `---
title: Changelog
---

Release notes.

## 1.22.2

_2026-06-25_

**Bug Fixes**

- An older fix.
`;

function fragment(fileName, category, weight, body) {
  return parseFragment(fileName, `---\ncategory: ${category}\nweight: ${weight}\n---\n\n${body}\n`);
}

const FRAGMENTS = [
  fragment("12-a-fix.md", "Bug Fixes", 50, "A new fix."),
  fragment("11-a-feature.md", "Features", 50, "A shiny new thing."),
];

describe("planChangelogFold", () => {
  it("folds the fragments into a dated section before the newest release", () => {
    const plan = planChangelogFold({ mdx: MDX, fragments: FRAGMENTS }, "1.23.0", "2026-07-01");

    expect(plan.fold).toBe(true);
    expect(plan.content).toBe(
      MDX.replace(
        "## 1.22.2",
        "## 1.23.0\n\n_2026-07-01_\n\n**Features**\n\n- A shiny new thing.\n\n**Bug Fixes**\n\n- A new fix.\n\n## 1.22.2",
      ),
    );
    expect(plan.section).toBe(
      "## 1.23.0\n\n_2026-07-01_\n\n**Features**\n\n- A shiny new thing.\n\n**Bug Fixes**\n\n- A new fix.\n",
    );
    expect(plan.fragmentPaths).toEqual(["changelog.d/12-a-fix.md", "changelog.d/11-a-feature.md"]);
    expect(plan.reason).toBe('Folded 2 fragments into "## 1.23.0" → _2026-07-01_');
  });

  it("skips a pre-release whatever the fragments hold", () => {
    for (const version of ["1.23.0-dev.0", "1.23.0-rc.1", "1.23.0-beta.2"]) {
      const plan = planChangelogFold({ mdx: MDX, fragments: FRAGMENTS }, version, "2026-07-01");
      expect(plan).toEqual({ fold: false, reason: expect.stringContaining(`Pre-release ${version}`) });
    }
  });

  it("is a no-op with no fragments", () => {
    const plan = planChangelogFold({ mdx: MDX, fragments: [] }, "1.23.0", "2026-07-01");
    expect(plan).toEqual({ fold: false, reason: expect.stringContaining("No fragments") });
  });

  it("refuses a release whose section already exists", () => {
    expect(() => planChangelogFold({ mdx: MDX, fragments: FRAGMENTS }, "1.22.2", "2026-07-01")).toThrow(
      /"## 1\.22\.2" section already exists/,
    );
  });

  it("refuses a fragment that repeats a released bullet", () => {
    const repeated = [fragment("13-repeat.md", "Bug Fixes", 50, "An older fix.")];
    expect(() => planChangelogFold({ mdx: MDX, fragments: repeated }, "1.23.0", "2026-07-01")).toThrow(
      /already in a released section/,
    );
  });

  it("validates the composed changelog with the What's New parser", () => {
    // Only buildChangelogData sees the whole file: a released section filed out
    // of newest-first order is a parser error, not a fragment error.
    const outOfOrder = MDX.replace("## 1.22.2", "## 1.24.0");
    expect(() => planChangelogFold({ mdx: outOfOrder, fragments: FRAGMENTS }, "1.23.0", "2026-07-01")).toThrow();
  });
});

describe("formatLocalDate", () => {
  it("formats a date as zero-padded YYYY-MM-DD in local time", () => {
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});
