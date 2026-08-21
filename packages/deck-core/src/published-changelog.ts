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

const CategorySchema = z.object({
  title: z.string(),
  items: z.array(z.string()),
});

const ReleaseSchema = z.object({
  version: z.string(),
  // `null` for a section still in development; the release tooling stamps the
  // date when a stable version is cut, which is what makes a release count as
  // published (see `selectAvailableUpdates`).
  date: z.string().nullable(),
  categories: z.array(CategorySchema),
});

const PublishedChangelogSchema = z.object({
  releases: z.array(ReleaseSchema),
});

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
  const parsed = PublishedChangelogSchema.safeParse(body);

  if (!parsed.success) return undefined;

  return parsed.data.releases.map((release) => ({
    ...release,
    categories: release.categories.map((category) => ({
      title: category.title,
      items: category.items.map(sanitizeChangelogHtml),
    })),
  }));
}
