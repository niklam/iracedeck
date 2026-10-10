# Changelog Maintenance

The public changelog at `packages/website/src/content/docs/changelog.mdx` is the user-facing record of every release, and the **single source of truth** for release notes everywhere. It is opened automatically in the user's browser on a version upgrade (see `version-check` in `@.claude/rules/global-settings.md`), and since #1011 it is also parsed at build time into the artifact the plugin's Settings window renders on its What's New tab — so it must stay in sync with what actually ships.

Since #1386 that source has two halves. `changelog.mdx` holds the **released** versions, one dated section each. The version **in development** is `changelog.d/` at the repository root, one fragment file per bullet, which every reader composes in as that version's `_Unreleased_` section and the release folds into `changelog.mdx`. Fragments exist because while every user-facing PR edited one shared section and a committed `changelog.json`, nearly every rebase conflicted and the merge gate then needed the maintainer; a fragment is a path no other PR touches. Decided in `docs/superpowers/specs/2026-10-10-issue-1386-changelog-fragments-merge-gate.md`; `changelog.d/README.md` documents the format in the folder.

## When to add one — required on merge to `master` or `release/*`

Any change that merges to `master` or a `release/*` branch and is **user-facing** MUST add a fragment in the **same PR**. A change is user-facing if a user can see or do something different: actions, modes, sub-actions, settings, Race Engineer callouts, icons, behavior, or the website.

Pure internal work (refactors, build/tooling, dependency bumps) with no user-visible effect may get a **Maintenance** fragment if notable, or none at all. Don't list internal churn line by line.

Never write an in-development section into `changelog.mdx` by hand: an `_Unreleased_` line there fails every reader.

## A fragment

`changelog.d/<number>-<slug>.md`: the issue number (or the PR's, when there is no issue) without a leading zero, then lowercase words joined by single hyphens, e.g. `1345-session-info-cpu.md`. Two bullets are two files.

```markdown
---
category: Bug Fixes
weight: 60
---

**Session Info** keys now use much less CPU and memory in a race. See [Session Info](/docs/actions/display-session/session-info/).
```

- **The frontmatter is exactly `category` and `weight`**, one `key: value` per line between the `---` fences — no quotes, comments, blank lines, other keys or repeats. A strict parser, not YAML.
- **`category`** is spelled exactly as one of `Features`, `Improvements`, `Bug Fixes`, `Breaking changes`, `Maintenance`.
- **`weight`** is a whole number from 1 to 100 (no sign, leading zero or decimal), with no default.
- **The body is one line**: the bullet text without its `- `, a self-contained sentence for users. It must not start with whitespace or with block syntax — a list marker, `#`, `>`, a code fence, a thematic break (`***`, `---`, `___`) or a link reference definition (`[label]: …`; a link `[label](…)` is fine) — since the fold writes it after a `- `.
- **`changelog.d/README.md` is the only non-fragment file.** Editor and OS litter is skipped (dotfiles, names ending in `~`, `Thumbs.db`, `desktop.ini`); any other file there is an error.

### Order

Categories print in the fixed order above, and one with no fragments gets no heading. Within a category a **higher weight is listed first**; **50 is ordinary**, higher for a headline change, lower for a minor one. Ties go to the **lower issue number**, then to the file name by code unit, so the order is the same on every machine.

### MDX safety and inline markdown

- **No bare `<` or `{` outside a backtick code span**, and **no escaped backtick** (`` \` ``), which would hide one: the fold writes MDX, where either breaks the website build, while the page's preview renders the fragment as plain markdown and would not show it. Wrap literals like `<name>` in backticks.
- **Inline markdown is limited to what the pane can render:** backtick code spans, `**bold**`, `*em*` / `_em_`, and `[text](url)` links whose target is a site-absolute path (`/docs/…`, rebased onto iracedeck.com for the window) or an `http(s)` URL. Anything else throws in `scripts/lib/changelog-inline-html.mjs`.

Every error names the file and, where there is one, the line.

## One change, one fragment — no repetition

The changelog records **what users get in a release**, not the PR history:

- A feature PR plus its follow-up fix/polish PRs, all in the **same** version → **one** `Features` fragment, never a feature fragment plus a fix fragment for it.
- A later PR that refines a change still in development **edits that change's fragment** — its text or its weight — rather than adding a second one.
- A **Bug Fixes** fragment is only for something that shipped in an **earlier** released version.

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

Fixing a typo in a released section is still an edit to `changelog.mdx`, not a fragment.

## Verify

`pnpm test` loads, composes and parses the real `changelog.d/` and `changelog.mdx`, so a malformed fragment fails the suite, and holds `changelog.json` gitignored with its turbo wiring in place. `pnpm --filter @iracedeck/website build` must pass; the page renders at `/changelog/` with the fragments on top. A fragment added or edited makes the Settings window screenshot stale; see `@.claude/rules/website-screenshots.md`.
