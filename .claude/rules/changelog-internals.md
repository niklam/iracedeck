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

One composer, `scripts/lib/changelog-fragments.mjs`, sits behind every reader, so the preview and the release are the same text. It renders the fragments as the in-development version's section — the root `package.json` `version` with any `-dev` / `-rc` suffix stripped — and inserts it before the first `## ` heading; with no fragments the MDX comes back unchanged. Its readers are the plugin's What's New data, the website's published `changelog.json` (both through `changelog-composed.mjs`, so their bytes are equal by construction, #1016), the website's changelog page (`packages/website/src/changelog-fragments-plugin.mjs`, a Sätteri mdast plugin, so the section is in Starlight's table of contents), and the release fold.

The composer refuses four drifts: an `_Unreleased_` line in `changelog.mdx`; a `## <version>` section for the in-development version while fragments exist (the fix is the bump to the next `-dev`); two fragments with the same bullet (delete one); and a fragment repeating a bullet already in a dated section, the shape a cherry-picked fix leaves (delete the fragment).

## The fold at a stable release

Nobody dates a section by hand. On a **stable** version, release-it's `before:bump` hook (`scripts/release-hooks.mjs`, `scripts/lib/changelog-fold.mjs`) composes every fragment with today's date and runs it through `buildChangelogData` **before anything is written**, so a malformed fragment aborts the release with a clean tree; an uncommitted or locally edited fragment is refused too. It then writes `changelog.mdx`, removes and stages every fragment with one `git rm`, checks they are gone from disk, and only then bumps the version files, all in the version-bump commit. A failure part-way leaves the folded `changelog.mdx` beside fragments that still exist, which a re-run refuses and the error's `git restore` command puts back.

- **Pre-releases** (`-dev` / `-rc` / `-alpha` / `-beta`) skip the fold, so an `-rc` build shows the fragments as Unreleased. Their notes are the eventual stable version's.
- **No fragments** is a logged no-op: that version gets no section.
- **`pnpm release:dry`** prints the section and the fragments it would delete, and writes nothing.

Fragments travel with their code, so whatever a branch holds at its stable bump are that release's notes; back-merges are in `@.claude/rules/build-and-commit.md`.

## `changelog.json` is a build artifact

The plugin ships its own copy of the notes (#1011): `packages/iracing-actions/src/actions/data/changelog.json`, compiled into each plugin's `ui/settings-window.html`. It is **gitignored and never committed** (#1386).

- **The root turbo task `//#generate:changelog-data`** builds it, and each plugin build lists it in `dependsOn`, so a fragment edit invalidates the plugin builds. Each plugin's `watch` script runs the generator once at start; an edit made while a watcher runs is stale until `pnpm generate:changelog-data`.
- **The post-edit hook runs the generator** in a Claude Code session whenever `changelog.mdx` or a fragment is edited (`@.claude/rules/hooks.md`). That run is the fragment's validation at authoring time. Run it by hand outside a session, or when the hook reports a failure.

## The dated sections' format is machine-read (#1011)

What the fold writes, and every released section in `changelog.mdx`, is parsed by `scripts/lib/changelog-parse.mjs` on every build. It throws, naming the line, on a heading that is not a plain `## X.Y.Z`, an unknown or out-of-order category header, a category header with no bullets, a bullet before any category, a duplicated version or category, a release out of strict newest-first order, and any other prose inside a release section — a malformed entry would drop a whole release from a pane read offline.

- `## <version>`, then a date line `_YYYY-MM-DD_`, newest version first. (`_Unreleased_` appears only in the composed text, never in the file.)
- Only these bold category headers, in this order, and only with content: `**Features**`, `**Improvements**`, `**Bug Fixes**`, `**Breaking changes**`, `**Maintenance**`.
- Plain single-line bullets, one self-contained sentence each. No PR numbers, download links or marketplace boilerplate; contributor credits are optional and inline (`(thanks @handle)`).
## Verify

Beyond what `changelog.md` lists, `pnpm test` holds `changelog.json` gitignored with its turbo wiring in place, and `pnpm --filter @iracedeck/website build` must pass; the page renders at `/changelog/` with the fragments on top.
