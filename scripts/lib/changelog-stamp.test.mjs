import { describe, expect, it } from "vitest";

import { formatLocalDate, stampChangelog } from "./changelog-stamp.mjs";

const CHANGELOG = `## 1.23.0

_Unreleased_

**Features**

- A shiny new thing.

## 1.22.2

_2026-06-25_

**Bug Fixes**

- An older fix.
`;

describe("stampChangelog", () => {
  it("stamps the matching stable version's _Unreleased_ line with the date", () => {
    const result = stampChangelog(CHANGELOG, "1.23.0", "2026-07-01");
    expect(result.stamped).toBe(true);
    expect(result.content).toContain("## 1.23.0\n\n_2026-07-01_");
    expect(result.content).not.toContain("_Unreleased_");
  });

  it("leaves older already-dated sections untouched", () => {
    const result = stampChangelog(CHANGELOG, "1.23.0", "2026-07-01");
    expect(result.content).toContain("## 1.22.2\n\n_2026-06-25_");
  });

  it.each(["1.23.0-dev.0", "1.23.0-rc.1", "1.23.0-alpha.1", "1.23.0-beta.2"])(
    "skips pre-release version %s without changing the changelog",
    (version) => {
      const result = stampChangelog(CHANGELOG, version, "2026-07-01");
      expect(result.stamped).toBe(false);
      expect(result.content).toBe(CHANGELOG);
      expect(result.reason).toMatch(/pre-release/i);
    },
  );

  it("is a no-op when no section matches the release version", () => {
    const result = stampChangelog(CHANGELOG, "9.9.9", "2026-07-01");
    expect(result.stamped).toBe(false);
    expect(result.content).toBe(CHANGELOG);
    expect(result.reason).toMatch(/no .*section/i);
  });

  it("does not overwrite a section that already has a real date", () => {
    const result = stampChangelog(CHANGELOG, "1.22.2", "2026-07-01");
    expect(result.stamped).toBe(false);
    expect(result.content).toBe(CHANGELOG);
    expect(result.reason).toMatch(/already dated/i);
  });

  it("matches the version heading exactly, not a longer version that shares the prefix", () => {
    const content = "## 1.22.20\n\n_Unreleased_\n\n**Features**\n\n- New.\n";
    const result = stampChangelog(content, "1.22.2", "2026-07-01");
    expect(result.stamped).toBe(false);
    expect(result.content).toBe(content);
    expect(result.content).toContain("_Unreleased_");
  });

  it("stamps only the matching section when more than one says _Unreleased_", () => {
    const content = "## 1.23.0\n\n_Unreleased_\n\n- New.\n\n## 1.22.9\n\n_Unreleased_\n\n- Other.\n";
    const result = stampChangelog(content, "1.23.0", "2026-07-01");
    expect(result.stamped).toBe(true);
    expect(result.content).toContain("## 1.23.0\n\n_2026-07-01_");
    expect(result.content).toContain("## 1.22.9\n\n_Unreleased_");
  });

  it("preserves CRLF line endings when stamping", () => {
    const content = "## 1.23.0\r\n\r\n_Unreleased_\r\n\r\n- New.\r\n";
    const result = stampChangelog(content, "1.23.0", "2026-07-01");
    expect(result.stamped).toBe(true);
    expect(result.content).toBe("## 1.23.0\r\n\r\n_2026-07-01_\r\n\r\n- New.\r\n");
  });
});

describe("formatLocalDate", () => {
  it("formats a date as zero-padded YYYY-MM-DD in local time", () => {
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});
