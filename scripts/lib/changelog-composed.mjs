// The changelog as every reader sees it (issue #1386): `changelog.mdx` with the
// in-development fragments of `changelog.d/` composed in as an undated section —
// `## <version>` / `_Unreleased_`, or `## Unreleased` in the window after a stable
// fold (#1398) — and the What's New artifact built from that text.
//
// The plugin's `changelog.json` (scripts/generate-changelog-data.mjs), the
// website's published copy (packages/website/scripts/generate-changelog-json.mjs)
// and the tests that used to read the committed artifact all go through these two
// functions, so the bytes the plugin ships and the bytes the website publishes are
// equal by construction (#1016), and none of them needs a prior build to exist.
//
// A separate module rather than a function in `changelog-data.mjs`, because
// `changelog-fragments.mjs` imports that module for its source path: composing
// from there would be an import cycle.
import { buildChangelogData } from "./changelog-data.mjs";
import { composeChangelog, loadChangelogSources } from "./changelog-fragments.mjs";

/**
 * Read the tree and compose the changelog with the fragments as its undated
 * first release, in preview mode: `## <X.Y.Z>` / `_Unreleased_` under the root
 * version without its pre-release suffix, or `## Unreleased` while the root
 * version is still exactly the newest dated one. The root version goes to the
 * composer as written, since a pre-release of the newest dated version is
 * refused rather than read as the window. With no fragments the MDX comes back
 * unchanged.
 *
 * @param {string} root - The repository root.
 * @returns {string} the composed MDX.
 * @throws on a malformed or stray file in `changelog.d/`, a hand-written
 *   in-development section, or any compose-time rule `composeChangelog` enforces.
 */
export function readComposedChangelog(root) {
  const { mdx, fragments, version } = loadChangelogSources(root);
  // `composeChangelog` refuses a hand-written in-development section first (an
  // `_Unreleased_` line or a `## Unreleased` heading), with or without fragments,
  // so one never reaches the pane beside the fragments.
  return composeChangelog(mdx, fragments, version, { mode: "preview" });
}

/**
 * The What's New artifact for the tree as it stands: the composed changelog run
 * through the unchanged `buildChangelogData`.
 *
 * @param {string} root - The repository root.
 * @returns {import("./changelog-data.mjs").ChangelogData}
 */
export function buildComposedChangelogData(root) {
  return buildChangelogData(readComposedChangelog(root));
}
