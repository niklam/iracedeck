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
