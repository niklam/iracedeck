/**
 * Which published releases are newer than the one running (issue #1016).
 *
 * Pure, and the whole product decision in one function:
 *
 * - **Dated means published.** The top section of `changelog.mdx` is the
 *   version still in development and carries `_Unreleased_` until the release
 *   tooling stamps it (`scripts/lib/changelog-stamp.mjs`). Announcing that
 *   would be exactly the complaint #1011 fixed — a version the user cannot
 *   have — so an undated release is never an available update.
 * - **Plain semver, no pre-release special case.** `3.1.0-dev.0` is already
 *   newer than `3.0.0`, so a dev build is never told it is behind a release it
 *   deliberately skipped; a `3.0.0-rc.1` build IS told that `3.0.0` shipped,
 *   which is true and worth knowing.
 */
import { gt, rcompare, valid } from "semver";

import type { PublishedRelease } from "./published-changelog.js";

/**
 * The published releases newer than `installedVersion`, newest first.
 *
 * An unparseable installed version yields an empty list rather than a guess:
 * with nothing to compare against, "there is an update" would be an assertion
 * we cannot support.
 */
export function selectAvailableUpdates(p: {
  installedVersion: string;
  releases: PublishedRelease[];
}): PublishedRelease[] {
  const { installedVersion, releases } = p;

  if (!valid(installedVersion)) return [];

  return releases
    .filter((release) => release.date !== null && valid(release.version) && gt(release.version, installedVersion))
    .sort((a, b) => rcompare(a.version, b.version));
}
