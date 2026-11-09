---
paths:
  - "changelog.d/**"
  - "packages/website/src/content/docs/changelog.mdx"
  - "packages/website/src/changelog-fragments-plugin.*"
  - "packages/website/scripts/generate-changelog-json.mjs"
  - "packages/website/astro.config.mjs"
  - "packages/app-updates/src/published-changelog*"
  - "scripts/lib/changelog-*"
  - "scripts/generate-changelog-data.*"
  - "scripts/release-hooks.mjs"
  - "scripts/website-changelog-json.test.mjs"
---

# Changelog — composition, fold and format

How the changelog fragments become release notes, for whoever edits the files that read or write them. When to add a fragment and how to write one is `@.claude/rules/changelog.md`, which every session loads; this file holds the pipeline behind it (moved out of it in #1465 to keep the always-loaded set inside its budget).

## How the fragments are read

One composer, `scripts/lib/changelog-fragments.mjs`, sits behind every reader, so the preview and the release are the same text. It renders the fragments as one section — for a reader, under the in-development version, the root `package.json` `version` with any `-dev` / `-rc` suffix stripped — and inserts it before the first `## ` heading; with no fragments the MDX comes back unchanged. Its readers are the plugin's What's New data, the website's published `changelog.json` (both through `changelog-composed.mjs`, so their bytes are equal by construction, #1016), the website's changelog page (`packages/website/src/changelog-fragments-plugin.mjs`, a Sätteri mdast plugin, so the section is in Starlight's table of contents), and the release fold.

Each caller names its mode (`composeChangelog(mdx, fragments, version, mode)`, #1398), and while fragments exist the mode decides the section:

- **Preview** (`{ mode: "preview" }`: the What's New data, the published `changelog.json`, the page) is handed the root version as written and compares that version V, its suffix stripped, with the newest `## ` section N. V newer than N, or no `## ` heading at all, gives `## V` / `_Unreleased_`, suffix or not. The root version being exactly N, with no pre-release suffix — the window after a stable fold, before the next bump, most often entered by back-merging a release fold into a `master` that has not bumped past the branch point — gives `## Unreleased` with no date line (`UNRELEASED_LABEL` in `changelog-parse.mjs`, which the parser accepts only first, once and undated). A pre-release of N (`3.8.1-dev.0` over `## 3.8.1`, a `master` bumped to a `-dev` of a hotfix it then back-merged) is behind N and refused, naming both and the bump to the next `-dev`: composed as the window, it would surface only at the next patch release, whose fold calls the tree half-folded. V behind N, or V's section below the newest, is refused as a misconfigured tree. In `changelog.json` the window section is `{ version: "Unreleased", date: null }`: the update check never offers it, since it drops undated and non-semver releases, and the pane shows its title with no date chip, the Installed badge staying on the dated release.
- **Fold** (`{ mode: "fold", date }`, `changelog-fold.mjs`) takes the release version, not `package.json`'s, writes `## <version>` / `_<date>_` and never `## Unreleased`, and refuses a `## <version>` section anywhere: a stable release always names a new version, so meeting its own section means a half-folded tree (below).

In either mode the composer also refuses three drifts: an `_Unreleased_` line or a `## Unreleased` heading in `changelog.mdx` (the label exists only in composed text); two fragments with the same bullet (delete one); and a fragment repeating a bullet already in a dated section, the shape a cherry-picked fix leaves (delete the fragment) and a half-folded tree too, which a preview therefore refuses rather than composing as Unreleased.

## The fold at a stable release

Nobody dates a section by hand. On a **stable** version, release-it's `before:bump` hook (`scripts/release-hooks.mjs`, `scripts/lib/changelog-fold.mjs`) composes every fragment with today's date and runs it through `buildChangelogData` **before anything is written**, so a malformed fragment aborts the release with a clean tree; an uncommitted or locally edited fragment is refused too. It then writes `changelog.mdx`, removes and stages every fragment with one `git rm`, checks they are gone from disk, and only then bumps the version files, all in the version-bump commit. A failure part-way leaves the folded `changelog.mdx` beside fragments that still exist, which a re-run refuses and the error's `git restore` command puts back.

- **Pre-releases** (`-dev` / `-rc` / `-alpha` / `-beta`) skip the fold, so an `-rc` build shows the fragments as Unreleased. Their notes are the eventual stable version's.
- **No fragments** is a logged no-op: that version gets no section.
- **`pnpm release:dry`** prints the section and the fragments it would delete, and writes nothing.
- **The screenshot capture follows the bump** (#1536): the `after:bump` hook (`scripts/release-capture.mjs`) rebuilds the Stream Deck plugin and captures the Settings window, What's New showing the folded section, into the same commit. A stable release therefore needs a Chromium browser and the native toolchain, since the bumped version rebuilds `iracing-native` and `audio-native`; an MSVC `LNK1318` abort means restore and rerun (`website-screenshots.md`).

Fragments travel with their code, so whatever a branch holds at its stable bump are that release's notes; back-merges are in `@.claude/rules/build-and-commit.md`.

## `changelog.json` is a build artifact

The plugin ships its own copy of the notes (#1011): `packages/iracing-actions/src/actions/data/changelog.json`, compiled into each plugin's `ui/settings-window.html`. It is **gitignored and never committed** (#1386).

- **The root turbo task `//#generate:changelog-data`** builds it, and each plugin build lists it in `dependsOn`, so a fragment edit invalidates the plugin builds. Each plugin's `watch` script runs the generator once at start; an edit made while a watcher runs is stale until `pnpm generate:changelog-data`.
- **The post-edit hook runs the generator** in a Claude Code session whenever `changelog.mdx` or a fragment is edited (`@.claude/rules/hooks.md`). That run is the fragment's validation at authoring time. Run it by hand outside a session, or when the hook reports a failure.

## The dated sections' format is machine-read (#1011)

What the fold writes, and every released section in `changelog.mdx`, is parsed by `scripts/lib/changelog-parse.mjs` on every build. It throws, naming the line, on a heading that is not a plain `## X.Y.Z`, an unknown or out-of-order category header, a category header with no bullets, a bullet before any category, a duplicated version or category, a release out of strict newest-first order, and any other prose inside a release section — a malformed entry would drop a whole release from a pane read offline.

- `## <version>`, then a date line `_YYYY-MM-DD_`, newest version first. (`_Unreleased_`, and the `## Unreleased` heading the parser accepts only first and with no date line, appear only in the composed text, never in the file.)
- Only these bold category headers, in this order, and only with content: `**Features**`, `**Improvements**`, `**Bug Fixes**`, `**Breaking changes**`, `**Maintenance**`.
- Plain single-line bullets, one self-contained sentence each. No PR numbers, download links or marketplace boilerplate; contributor credits are optional and inline (`(thanks @handle)`).
## Verify

Beyond what `changelog.md` lists, `pnpm test` holds `changelog.json` gitignored with its turbo wiring in place, and `pnpm --filter @iracedeck/website build` must pass; the page renders at `/changelog/` with the fragments on top.
