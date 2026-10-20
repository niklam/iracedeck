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

## Checking a fragment, and the rest of the pipeline

The post-edit hook regenerates the changelog data whenever a fragment or `changelog.mdx` is edited in a Claude Code session, and that run is the fragment's validation; outside a session run `pnpm generate:changelog-data`. `pnpm test` composes and parses the real `changelog.d/` and `changelog.mdx` too. `changelog.json` is a gitignored build artifact, never committed. A fragment added or edited makes the Settings window screenshot stale (`@.claude/rules/website-screenshots.md`). Fixing a typo in a released section is an edit to `changelog.mdx`, not a fragment.

How the fragments are composed, the fold at a stable release, the `changelog.json` artifact and the machine-read format of the dated sections are in `changelog-internals.md`, which loads with `changelog.d/`, `changelog.mdx` and the `scripts/` that read them.
