# Changelog fragments

The release notes for the version in development live here, one file per bullet. Every reader composes them into `packages/website/src/content/docs/changelog.mdx` as that version's section: the website's changelog page, the plugin's What's New tab and the release itself. At a stable release the fragments are folded into a dated section of `changelog.mdx` and deleted, so this folder is empty again apart from this file.

## A fragment

`changelog.d/<number>-<slug>.md`, where the number is the issue (or, for a PR with no issue, the PR) and the slug is lowercase words joined by hyphens, for example `1345-session-info-cpu.md`. A change with two bullets adds two files.

```markdown
---
category: Bug Fixes
weight: 60
---

**Session Info** keys now use much less CPU and memory in a race. See [Session Info](/docs/actions/display-session/session-info/).
```

- **The frontmatter has exactly two keys**, one `key: value` per line between the `---` fences, and nothing else: no quotes, comments or blank lines.
- **`category`** is spelled exactly as one of `Features`, `Improvements`, `Bug Fixes`, `Breaking changes`, `Maintenance`. Categories appear in that order, and one with no fragments gets no heading.
- **`weight`** is a whole number from 1 to 100, and a higher weight is listed first within its category. 50 is ordinary; go higher for headline changes, lower for minor ones. It has no default. Ties go to the lower issue number, then to the file name.
- **The body is one line**: the bullet text without its `- ` marker, written as a self-contained sentence for users.
- **No bare `<` or `{`** outside a backtick code span, because the text ends up in MDX. Inline markdown is limited to code spans, `**bold**`, `*em*` / `_em_`, and links whose target starts with `/` (a website path) or `http(s)://`.

Files your editor or the OS leave here (dotfiles such as `.DS_Store` or a swap file, backups ending in `~`, `Thumbs.db`, `desktop.ini`) are ignored. Any other file in this folder, a mis-named fragment included, is an error.

## One change, one fragment

A fragment describes what users get, not a PR. When a follow-up PR refines a change that is still in development, it edits that change's existing fragment rather than adding a second one. A **Bug Fixes** fragment is only for something that shipped in an earlier release.

The full rules are in `.claude/rules/changelog.md`.
