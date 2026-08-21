import { describe, expect, it } from "vitest";

import { parsePublishedChangelog } from "./published-changelog.js";

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
});
