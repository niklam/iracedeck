# Changelog Maintenance

The public changelog at `packages/website/src/content/docs/changelog.mdx` is the user-facing record of every release, and the **single source of truth** for release notes everywhere. It is opened automatically in the user's browser on a version upgrade (see `version-check` in `@.claude/rules/global-settings.md`), and since #1011 it is also parsed at build time into the artifact the plugin's Settings window renders on its What's New tab — so it must stay in sync with what actually ships.

Since #1386 that source has two halves. `changelog.mdx` holds the **released** versions, one dated section each. The version **in development** is a folder of fragments, `changelog.d/` at the repository root, one file per bullet, which every reader composes into the changelog as that version's `_Unreleased_` section and the release folds into `changelog.mdx` when it ships. The reason is conflicts: while every user-facing PR edited the same section and regenerated a committed `changelog.json`, nearly every rebase conflicted, and the merge gate then needed the maintainer. A fragment's file name carries only its identity, so two PRs never touch the same path.

Decided in `docs/superpowers/specs/2026-10-10-issue-1386-changelog-fragments-merge-gate.md`; `changelog.d/README.md` documents the format for whoever opens the folder.

## When to add one — required on merge to `master` or `release/*`

Any change that merges to `master` or a `release/*` branch and is **user-facing** MUST add a fragment in the **same PR**. A change is user-facing if a user can see or do something different: actions, modes, sub-actions, settings, Race Engineer callouts, icons, behavior, or the website.

Pure internal work (refactors, build/tooling, dependency bumps) with no user-visible effect may get a **Maintenance** fragment if notable, or none at all. Don't list internal churn line by line.

Never write an in-development section into `changelog.mdx` by hand. An `_Unreleased_` line there fails every reader (`assertNoInDevelopmentSection`), because a hand-written section would otherwise reach the pane while the fragments are the notes.

## A fragment

`changelog.d/<number>-<slug>.md`, where the number is the issue (or, for a PR with no issue, the PR) without a leading zero, and the slug is lowercase words joined by single hyphens: `1345-session-info-cpu.md`. A change with two bullets adds two files.

```markdown
---
category: Bug Fixes
weight: 60
---

**Session Info** keys now use much less CPU and memory in a race. See [Session Info](/docs/actions/display-session/session-info/).
```

- **The frontmatter is exactly `category` and `weight`**, one `key: value` per line between the `---` fences: no quotes, comments, blank lines, other keys or a key twice. A strict two-key parser rather than a YAML library, so nothing has to police the quoting, comments and anchors YAML would accept, and the root scripts stay dependency-free.
- **`category`** is spelled exactly as one of `Features`, `Improvements`, `Bug Fixes`, `Breaking changes`, `Maintenance`.
- **`weight`** is a whole number from 1 to 100 — no sign, leading zero or decimal. It has no default, because a missing weight would sort as a number nobody chose.
- **The body is one line**: the bullet text without its `- ` marker, written as a self-contained sentence for users. It must not start with whitespace, a list marker, a heading `#` or a blockquote `>`, since the fold writes it after a `- ` and any of those would make it something else.
- **`changelog.d/README.md` is the one non-fragment file.** Any other file there, a mis-named fragment or a directory included, is an error rather than silently skipped.

The category and weight sit in frontmatter rather than in the name (the towncrier `1345.bugfix.md` shape) because a weight in the name would make every re-ranking a rename.

### Order: weight, then issue, then name

Categories print in the fixed order above, and one with no fragments gets no heading. Within a category a **higher weight is listed first**. **50 is ordinary**; go higher for a headline change, lower for a minor one. Ties go to the **lower issue number**, then to the full file name compared by code unit. Ascending issue number reproduces the old habit of appending, so older work reads first; code-unit comparison rather than `localeCompare` makes the order the same on every machine and independent of directory listing order.

### MDX safety and inline markdown

- **No bare `<` or `{` outside a backtick code span.** The fold writes the text into MDX, where either breaks the website build — and the page's preview renders the fragment as plain markdown, so without this check a bullet would look fine until release day. Wrap literals like `<name>` in backticks.
- **Inline markdown is limited to what the pane can render:** backtick code spans, `**bold**`, `*em*` / `_em_`, and `[text](url)` links whose target is either a site-absolute path (`/docs/…`, rebased onto iracedeck.com for the window) or an `http(s)` URL. Anything else throws in `scripts/lib/changelog-inline-html.mjs` rather than reaching a user as raw markup.

Every error names the file and, where there is one, the line.

## One change, one fragment — no repetition

The changelog records **what users get in a release**, not the PR history. Collapse all the PRs that build one capability within the **same** release into a **single** fragment describing the final shipped behavior:

- A feature PR plus any follow-up fix/polish PRs for that **same** feature, all landing in the **same** version → **one** `Features` fragment. Never a feature fragment plus a separate fix fragment for it.
- When a later PR refines a change that is still in development, it **edits that change's existing fragment** — its text, or its weight — rather than adding a second one.
- A **Bug Fixes** fragment is only for fixing something that shipped in an **earlier** released version.

## How the fragments are read

One composer sits behind every reader, so the preview and the eventual release are the same text. `scripts/lib/changelog-fragments.mjs` owns the parser, the sort, `renderReleaseSection` and `composeChangelog`, which renders the fragments as the in-development version's section and inserts it before the first `## ` heading; its `loadChangelogSources` reads `changelog.mdx`, `changelog.d/` and the version, which is the root `package.json` `version` with any `-dev` / `-rc` suffix stripped. `scripts/lib/changelog-composed.mjs` composes that with `_Unreleased_` and builds the What's New data from it. With no fragments the MDX comes back unchanged and there is no in-development section, which is the state straight after a release.

- **The plugin's What's New data** — `pnpm generate:changelog-data`, below.
- **The website's published `changelog.json`** — the website build's `generate:changelog-json`, through the same `changelog-composed.mjs`, so the bytes the plugin ships and the bytes the site publishes are equal by construction (#1016).
- **The website's changelog page** — `packages/website/src/changelog-fragments-plugin.mjs`, an mdast plugin for Sätteri, Astro 7's default Markdown processor, wired in `astro.config.mjs`. It renders the section with `renderReleaseSection` and splices it into `changelog.mdx` before the first `##` heading, at the mdast stage so the section lands in Starlight's table of contents with the anchor a hand-written one had. A remark plugin would have needed the whole site switched to `@astrojs/markdown-remark`.
- **The release fold**, below, composes with the real date.

On the way, the composer refuses three things a tree can drift into: an `_Unreleased_` line left in `changelog.mdx`; a `## <version>` section for the in-development version while fragments exist (the fix is the bump to the next `-dev`); and a fragment whose bullet text equals a bullet already in a dated section — the shape a cherry-picked fix leaves behind, which would otherwise ship twice (delete the fragment).

## The fold at a stable release

The release tooling turns the fragments into a dated section; nobody dates one by hand. In release-it's `before:bump` hook (`scripts/release-hooks.mjs`), on a **stable** version only, `scripts/lib/changelog-fold.mjs`'s `planChangelogFold` composes every fragment with today's local date (`_YYYY-MM-DD_`, `formatLocalDate`) and runs the result through `buildChangelogData` — the What's New pane's own parser and renderer — **before anything is written**, so a malformed fragment aborts the release with a clean tree. An uncommitted fragment is refused too, since it would pass the `git add --dry-run` preflight and then fail the final `git add` half-way through. The hook then writes `changelog.mdx`, deletes the fragments, and stages the edit and the deletions in the version-bump commit.

- **Pre-releases** (`-dev` / `-rc` / `-alpha` / `-beta`) skip the fold, so an `-rc` build shows the fragments as the Unreleased release. They get no section of their own: their notes are the eventual stable version's.
- **No fragments** is a logged no-op: that version gets no section, and the pane honestly says it has no notes for it.
- **`pnpm release:dry`** prints the section it would write and the fragments it would delete, and writes nothing.

Fragments travel with their code across branches: whatever fragments a branch holds at its stable bump are that release's notes. How that plays out in a back-merge, including the one modify/delete conflict, is in *Back-merging a release branch* in `@.claude/rules/build-and-commit.md`.

## `changelog.json` is a build artifact

The plugin ships its own copy of the notes (#1011): `packages/iracing-actions/src/actions/data/changelog.json`, which all three plugin builds compile into `ui/settings-window.html`. Since #1386 it is **gitignored and never committed** — committing it was half of what made every changelog edit conflict.

- **The root turbo task `//#generate:changelog-data`** runs `scripts/generate-changelog-data.mjs` and caches the file as its output. Its inputs are `changelog.mdx`, `changelog.d/**`, the `scripts/lib/changelog-*.mjs` modules, the script and the root `package.json`, and each plugin build lists it in `dependsOn`, so a fragment edit invalidates the plugin builds and a cache hit restores the file. The website build hashes `changelog.d/**` and the root `package.json` for its own copy.
- **`rollup -w` does not run turbo.** Under a watcher, a changelog or fragment edit is stale in the window until `pnpm generate:changelog-data` runs.
- **The post-edit hook runs the generator** in a Claude Code session whenever `changelog.mdx` or a fragment other than the README is edited (`@.claude/rules/hooks.md`). That run is the fragment's validation at authoring time: composing is what checks it, so a bad fragment fails while you are writing it rather than at the next build. Run it by hand outside a session, or when the hook reports a failure.

## The dated sections' format is machine-read (#1011)

What the fold writes, and every released section in `changelog.mdx`, is parsed by `scripts/lib/changelog-parse.mjs` on every build, so the format below is enforced, not merely conventional. The parser throws — naming the line — on a heading that is not a plain `## X.Y.Z`, an unknown or out-of-order category header, a category header with no bullets under it, a bullet before any category, a duplicated version or category, a release filed out of strict newest-first order, and any other prose inside a release section. A malformed entry would drop a whole release from a pane read offline, so it fails instead.

- `## <version>` heading, then a date line: `_YYYY-MM-DD_`. Newest version first. (`_Unreleased_` appears only in the composed text, never in the file.)
- Only these category headers, bold, in this fixed order, and only when they have content: `**Features**`, `**Improvements**`, `**Bug Fixes**`, `**Breaking changes**`, `**Maintenance**`.
- Plain single-line bullets — one user-facing change per bullet, written as a self-contained sentence. No PR numbers, no download links, no marketplace boilerplate. Contributor credits are optional and inline (e.g. `(thanks @handle)`).
- It's MDX: a bare `<` or `{` breaks the build, and the inline-markdown limits above apply.

Editing a released section by hand is still fine: a typo fix in a past release is an edit to `changelog.mdx`, not a fragment.

## Verify

`pnpm test` must pass: `scripts/lib/changelog-fragments.test.mjs` and `changelog-composed.test.mjs` load, compose and parse the real `changelog.d/` and `changelog.mdx`, so a malformed fragment fails the suite, and `scripts/generate-changelog-data.test.mjs` holds `changelog.json` gitignored and untracked and the turbo wiring in place. `pnpm --filter @iracedeck/website build` must pass too; the page renders at `/changelog/` with the fragments as its top section. When a release's notes change — a fragment added or edited included — the Settings window screenshot is stale; see `@.claude/rules/website-screenshots.md`.
