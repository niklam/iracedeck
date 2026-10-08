import { describe, expect, it } from "vitest";

import type { PublishedRelease } from "./published-changelog.js";
import { selectAvailableUpdates } from "./update-check.js";

function release(version: string, date: string | null = "2026-08-14"): PublishedRelease {
  return { version, date, categories: [{ title: "Features", items: ["A thing."] }] };
}

describe("selectAvailableUpdates", () => {
  it("returns releases strictly newer than the installed version", () => {
    const found = selectAvailableUpdates({
      installedVersion: "2.4.0",
      releases: [release("2.6.0"), release("2.5.0"), release("2.4.0"), release("2.3.0")],
    });

    expect(found.map((r) => r.version)).toEqual(["2.6.0", "2.5.0"]);
  });

  it("returns nothing when the installed version is the newest", () => {
    expect(selectAvailableUpdates({ installedVersion: "2.6.0", releases: [release("2.6.0")] })).toEqual([]);
  });

  it("ignores an undated release — it has not shipped yet", () => {
    const found = selectAvailableUpdates({
      installedVersion: "2.4.0",
      releases: [release("2.5.0", null), release("2.4.0")],
    });

    expect(found).toEqual([]);
  });

  it.each(["", "not-a-date", "2026-02-30", "2026-13-01", "2026-8-14", "2026-08-14T00:00:00Z"])(
    "does not treat %s as a publication date",
    (date) => {
      // The artifact arrives over the network. A value we cannot read as a date
      // is no evidence that anything shipped, so it must not be offered.
      expect(selectAvailableUpdates({ installedVersion: "2.4.0", releases: [release("2.6.0", date)] })).toEqual([]);
    },
  );

  it("accepts a real leap day", () => {
    const found = selectAvailableUpdates({ installedVersion: "2.4.0", releases: [release("2.6.0", "2024-02-29")] });

    expect(found.map((r) => r.version)).toEqual(["2.6.0"]);
  });

  it("skips only the release it cannot date, not the whole artifact", () => {
    // One bad date must never cost the user every update notice.
    const found = selectAvailableUpdates({
      installedVersion: "2.4.0",
      releases: [release("2.7.0", "banana"), release("2.6.0")],
    });

    expect(found.map((r) => r.version)).toEqual(["2.6.0"]);
  });

  it("sorts newest first even when the artifact is not ordered", () => {
    const found = selectAvailableUpdates({
      installedVersion: "2.0.0",
      releases: [release("2.1.0"), release("2.10.0"), release("2.2.0")],
    });

    expect(found.map((r) => r.version)).toEqual(["2.10.0", "2.2.0", "2.1.0"]);
  });

  it("does not tell a dev build of a later version that an earlier release is newer", () => {
    expect(selectAvailableUpdates({ installedVersion: "3.1.0-dev.0", releases: [release("3.0.0")] })).toEqual([]);
  });

  it("tells a release candidate that its stable version shipped", () => {
    const found = selectAvailableUpdates({ installedVersion: "3.0.0-rc.1", releases: [release("3.0.0")] });

    expect(found.map((r) => r.version)).toEqual(["3.0.0"]);
  });

  it("ignores a release whose version is not valid semver", () => {
    expect(selectAvailableUpdates({ installedVersion: "2.4.0", releases: [release("next")] })).toEqual([]);
  });

  it("returns nothing when the installed version is not valid semver", () => {
    expect(selectAvailableUpdates({ installedVersion: "", releases: [release("2.6.0")] })).toEqual([]);
  });

  it("returns nothing for an empty release list", () => {
    expect(selectAvailableUpdates({ installedVersion: "2.4.0", releases: [] })).toEqual([]);
  });
});
