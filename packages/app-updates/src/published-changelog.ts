/**
 * The changelog artifact the website publishes, and how the plugin reads it
 * (issue #1016).
 *
 * `https://iracedeck.com/changelog.json` is generated from the same
 * `changelog.mdx` — by the same parser — as the copy compiled into the build,
 * so the shape here matches `scripts/lib/changelog-data.mjs` exactly. Only the
 * fields the update check needs are modelled; anything the artifact grows
 * later is ignored rather than rejected, so publishing a new field cannot
 * break older plugins.
 *
 * Bullets are sanitized HERE, on the way in — every consumer downstream can
 * then treat an item as safe to render, and there is one place to look to
 * confirm that nothing renders unsanitized remote markup.
 */
import { z } from "zod";

import { sanitizeChangelogHtml } from "./changelog-html-sanitize.js";

/**
 * Caps on the artifact's shape (#1101). The byte cap in `changelog-feed-client.ts`
 * bounds the document; these refuse a well-formed but absurd one before its
 * bullets are sanitized one by one. Each is far above anything the changelog
 * holds — 41 releases, five category headers at most, 14 bullets in the
 * longest category in October 2026 — and `published-changelog.test.ts` fails
 * while the committed artifact still has half of every one left.
 */
export const PUBLISHED_CHANGELOG_MAX_RELEASES = 1000;
export const PUBLISHED_CHANGELOG_MAX_CATEGORIES = 20;
export const PUBLISHED_CHANGELOG_MAX_ITEMS = 200;

const CategorySchema = z.object({
  title: z.string(),
  items: z.array(z.string()).max(PUBLISHED_CHANGELOG_MAX_ITEMS),
});

const ReleaseSchema = z.object({
  version: z.string(),
  // `null` for a section still in development; the release tooling stamps the
  // date when a stable version is cut, which is what makes a release count as
  // published (see `selectAvailableUpdates`).
  date: z.string().nullable(),
  categories: z.array(CategorySchema).max(PUBLISHED_CHANGELOG_MAX_CATEGORIES),
});

// `releases` is length-checked BEFORE any release is validated: zod runs an
// array's element schema over every element and only then applies `.max()`,
// so a capped `z.array(ReleaseSchema)` would still validate all of them.
const PublishedChangelogSchema = z.object({
  releases: z.array(z.unknown()).max(PUBLISHED_CHANGELOG_MAX_RELEASES),
});

const ReleasesSchema = z.array(ReleaseSchema);

export type PublishedReleaseCategory = z.infer<typeof CategorySchema>;
export type PublishedRelease = z.infer<typeof ReleaseSchema>;

/**
 * Validate a fetched artifact and sanitize its bullets.
 *
 * Returns `undefined` for anything that does not parse — the caller treats
 * that exactly like a failed request, because a body we cannot trust the shape
 * of is no more useful than no body at all.
 */
export function parsePublishedChangelog(body: unknown): PublishedRelease[] | undefined {
  const document = PublishedChangelogSchema.safeParse(body);

  if (!document.success) return undefined;

  const releases = ReleasesSchema.safeParse(document.data.releases);

  if (!releases.success) return undefined;

  return releases.data.map((release) => ({
    ...release,
    categories: release.categories.map((category) => ({
      title: category.title,
      items: category.items.map(sanitizeChangelogHtml),
    })),
  }));
}
