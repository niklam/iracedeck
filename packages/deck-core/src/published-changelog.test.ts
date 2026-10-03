import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { CHANGELOG_MAX_BYTES } from "./changelog-feed-client.js";
import { parsePublishedChangelog, PUBLISHED_CHANGELOG_MAX_RELEASES } from "./published-changelog.js";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");

const VALID = {
  _meta: { generatedFrom: "…", generatedBy: "…", note: "…" },
  releases: [
    { version: "2.6.0", date: "2026-08-14", categories: [{ title: "Features", items: ["A <strong>thing</strong>."] }] },
    { version: "2.5.0", date: null, categories: [] },
  ],
};

describe("parsePublishedChangelog", () => {
  it("parses a well-formed artifact", () => {
    const releases = parsePublishedChangelog(VALID);

    expect(releases).toHaveLength(2);
    expect(releases?.[0]).toEqual({
      version: "2.6.0",
      date: "2026-08-14",
      categories: [{ title: "Features", items: ["A <strong>thing</strong>."] }],
    });
  });

  it("keeps a null date rather than inventing one", () => {
    expect(parsePublishedChangelog(VALID)?.[1].date).toBeNull();
  });

  it("sanitizes every bullet on the way through", () => {
    const releases = parsePublishedChangelog({
      releases: [
        {
          version: "2.6.0",
          date: "2026-08-14",
          categories: [{ title: "Features", items: ['<script>alert(1)</script><a href="https://x.test/">ok</a>'] }],
        },
      ],
    });

    expect(releases?.[0].categories[0].items[0]).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;<a href="https://x.test/" target="_blank" rel="noopener noreferrer">ok</a>',
    );
  });

  it("ignores unknown top-level fields", () => {
    expect(parsePublishedChangelog({ ...VALID, somethingNew: 42 })).toHaveLength(2);
  });

  it("does not reject the whole artifact over one unreadable date", () => {
    // Deliberate: the date is validated where it is USED (selectAvailableUpdates),
    // so a release we cannot date is skipped on its own rather than taking every
    // other release's update notice down with it.
    const releases = parsePublishedChangelog({
      releases: [{ version: "2.6.0", date: "banana", categories: [] }],
    });

    expect(releases).toHaveLength(1);
    expect(releases?.[0].date).toBe("banana");
  });

  it("returns undefined when releases is missing", () => {
    expect(parsePublishedChangelog({ _meta: {} })).toBeUndefined();
  });

  it("returns undefined when a release is malformed", () => {
    expect(parsePublishedChangelog({ releases: [{ version: 7, date: null, categories: [] }] })).toBeUndefined();
  });

  it("returns undefined for a non-object body", () => {
    expect(parsePublishedChangelog("nope")).toBeUndefined();
    expect(parsePublishedChangelog(null)).toBeUndefined();
    expect(parsePublishedChangelog([])).toBeUndefined();
  });

  it("accepts an artifact with no releases at all", () => {
    expect(parsePublishedChangelog({ releases: [] })).toEqual([]);
  });

  it("returns undefined for a well-formed artifact listing more releases than the cap", () => {
    const releases = (n: number) => Array.from({ length: n }, () => ({ version: "1.0.0", date: null, categories: [] }));

    expect(parsePublishedChangelog({ releases: releases(PUBLISHED_CHANGELOG_MAX_RELEASES + 1) })).toBeUndefined();
    expect(parsePublishedChangelog({ releases: releases(PUBLISHED_CHANGELOG_MAX_RELEASES) })).toHaveLength(
      PUBLISHED_CHANGELOG_MAX_RELEASES,
    );
  });
});

// The changelog grows with every release, and a published artifact over either
// cap reads as "we do not know" on every plugin in the field — silently, since
// the What's New tab then just shows its built-in notes. The compiled-in copy
// is built by the same generator from the same changelog.mdx as the published
// one, so measuring it here fails the build while there is still half the
// budget left to raise a cap in, rather than on the day the feed goes dark.
describe("published changelog headroom (#1101)", () => {
  const artifact = readFileSync(
    path.join(repoRoot, "packages/iracing-actions/src/actions/data/changelog.json"),
    "utf-8",
  );

  it("is under half the byte cap", () => {
    expect(Buffer.byteLength(artifact, "utf-8")).toBeLessThan(CHANGELOG_MAX_BYTES / 2);
  });

  it("is under half the release cap", () => {
    const releases = parsePublishedChangelog(JSON.parse(artifact));

    expect(releases).toBeDefined();
    expect(releases?.length).toBeLessThan(PUBLISHED_CHANGELOG_MAX_RELEASES / 2);
  });
});
