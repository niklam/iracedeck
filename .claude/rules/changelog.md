---

# Changelog Maintenance

The public changelog at `packages/website/src/content/docs/changelog.mdx` is the user-facing record of every release, and the **single source of truth** for release notes everywhere. It is opened automatically in the user's browser on a version upgrade (see `version-check` in `@.claude/rules/global-settings.md`), and since #1011 it is also parsed at build time into the artifact the plugin's Settings window renders on its What's New tab — so it must stay in sync with what actually ships.

## When to update — required on merge to `master` or `release/*`

Any change that merges to `master` or a `release/*` branch and is **user-facing** MUST update the changelog in the **same PR**. A change is user-facing if a user can see or do something different: actions, modes, sub-actions, settings, Race Engineer callouts, icons, behavior, or the website. Add the entry under the in-development version (see below).

Pure internal work (refactors, build/tooling, dependency bumps) with no user-visible effect may be summarized under **Maintenance** if notable, or omitted entirely. Don't list internal churn line-by-line.

## The in-development version section

Entries accumulate under the **top** `##` heading — the next unreleased version (the `version` in the root `package.json` with any `-dev` / `-rc` suffix stripped). If that version's section doesn't exist yet, create it at the very top of the list (the list is strictly newest-first). Leave its date line as `_Unreleased_` — the release tooling **stamps the real `_YYYY-MM-DD_` automatically** when you cut a **stable** release: the `before:bump` hook (`scripts/release-hooks.mjs`, via `scripts/lib/changelog-stamp.mjs`) replaces the matching section's `_Unreleased_` line with the release date (local time) and stages `changelog.mdx` in the same version-bump commit. Pre-releases (`-dev` / `-rc` / `-alpha` / `-beta`) are skipped, and a missing or already-dated section is a logged no-op, so a release never fails on the changelog and you never edit the date by hand. When it does stamp, the same hook **regenerates `changelog.json`** from the stamped file and stages it too — otherwise the release would ship a build whose What's New pane calls the version the user just installed "Unreleased", and leave the freshness test red on the release commit.

Pre-release versions (`-alpha` / `-beta` / `-rc`) get **no** section of their own — fold their notes into the eventual stable version's section.

## The format is machine-read (#1011)

The plugin ships its own copy of these notes: `pnpm generate:changelog-data` parses this file into `packages/iracing-actions/src/actions/data/changelog.json`, which all three plugin builds compile into `ui/settings-window.html`. Two consequences:

- **Run `pnpm generate:changelog-data` after editing this file, and commit the regenerated JSON.** A freshness test (`scripts/generate-changelog-data.test.mjs`) fails the build otherwise, naming the command.
- **The format below is enforced, not merely conventional.** `scripts/lib/changelog-parse.mjs` throws — naming the line — on a heading that is not a plain `## X.Y.Z`, an unknown or out-of-order category header, a category header with no bullets under it, a bullet before any category, a duplicated version or category, a release filed out of strict newest-first order, and any other prose inside a release section. A malformed entry used to render slightly oddly on the website; now it would drop a whole release from a pane read offline, so it fails instead. `scripts/lib/changelog-parse.test.mjs` runs the parser over this very file, which is where that failure surfaces.

Inline markdown inside a bullet is limited to what the pane can render: backtick code spans, `**bold**`, `*em*` / `_em_`, and `[text](url)` links whose target is either a site-absolute path (`/docs/…`, rebased onto iracedeck.com for the window) or an `http(s)` URL. Anything else throws in `scripts/lib/changelog-inline-html.mjs` rather than reaching a user as raw markup.

## One change, one line — no repetition

The changelog records **what users get in a release**, not the PR history. Collapse all the PRs that build one capability within the **same** release into a **single** line describing the final shipped behavior:

- A feature PR plus any follow-up fix/polish PRs for that **same** feature, all landing in the **same** version → **one** `**Features**` line. Never a "feature" line plus a separate "fix" line for it.
- A `**Bug Fixes**` line is only for fixing something that shipped in an **earlier** released version.
- When a later PR refines a capability already listed in the in-development section, **edit that existing line** — do not add a second one.

## Format (match the existing entries exactly)

- `## <version>` heading, then a date line: `_YYYY-MM-DD_`, or `_Unreleased_` until it ships. Newest version first.
- Only these category headers, bold, in this fixed order, and only when they have content: `**Features**`, `**Improvements**`, `**Bug Fixes**`, `**Breaking changes**`, `**Maintenance**`.
- Plain bullets — one user-facing change per bullet, written as a self-contained sentence. No PR numbers, no download links, no marketplace boilerplate. Contributor credits are optional and inline (e.g. `(thanks @handle)`).
- It's MDX: a bare `<` or `{` breaks the build — wrap literals like `<name>` in backticks.

## Verify

`pnpm --filter @iracedeck/website build` must pass; the page renders at `/changelog/`.

`pnpm generate:changelog-data` must have been run and its output committed, and `pnpm test` must pass — the parser test and the freshness test both read this file. When a release's notes change, the Settings window screenshot is stale too; see `@.claude/rules/website-screenshots.md`.
