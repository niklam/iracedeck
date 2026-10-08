/**
 * Which published releases are newer than the one running (issue #1016).
 *
 * Pure, and the whole product decision in one function:
 *
 * - **Dated means published.** The top section of `changelog.mdx` is the
 *   version still in development and carries `_Unreleased_` until the release
 *   tooling stamps it (`scripts/lib/changelog-stamp.mjs`). Announcing that
 *   would be exactly the complaint #1011 fixed — a version the user cannot
 *   have — so an undated release is never an available update. "Dated" means a
 *   real calendar date, not merely a non-null string: the artifact arrives over
 *   the network, and a value we cannot read as a date is no evidence that
 *   anything shipped.
 * - **Plain semver, no pre-release special case.** `3.1.0-dev.0` is already
 *   newer than `3.0.0`, so a dev build is never told it is behind a release it
 *   deliberately skipped; a `3.0.0-rc.1` build IS told that `3.0.0` shipped,
 *   which is true and worth knowing.
 */
import { gt, rcompare, valid } from "semver";
import { z } from "zod";

import type { PublishedRelease } from "./published-changelog.js";

/**
 * A real calendar date in `YYYY-MM-DD`, the form the release tooling stamps
 * (`scripts/lib/changelog-stamp.mjs`). Zod does the calendar work, so
 * `2026-02-30` and `2026-13-01` are rejected while `2024-02-29` is not.
 *
 * Checked HERE rather than in the artifact's schema on purpose. The date is
 * what makes a release count as published, so an arbitrary string must not
 * qualify — but rejecting it in `published-changelog.ts` would fail the parse
 * of the WHOLE artifact, and one bad date on one release would silently cost
 * the user every update notice. Validating at the decision instead degrades one
 * release at a time: a release we cannot date is simply not offered, and the
 * rest still are.
 */
const PUBLISHED_DATE = z.iso.date();

/** True when `date` is a real calendar date, i.e. the release has shipped. */
function isPublished(date: string | null): boolean {
  return date !== null && PUBLISHED_DATE.safeParse(date).success;
}

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
    .filter((release) => isPublished(release.date) && valid(release.version) && gt(release.version, installedVersion))
    .sort((a, b) => rcompare(a.version, b.version));
}
