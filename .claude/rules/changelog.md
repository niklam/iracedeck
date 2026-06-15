---

# Changelog Maintenance

The public changelog at `packages/website/src/content/docs/changelog.mdx` is the user-facing record of every release. It is opened automatically in the user's browser on a version upgrade (see `version-check` in `@.claude/rules/global-settings.md`), so it must stay in sync with what actually ships.

## When to update — required on merge to `master` or `release/*`

Any change that merges to `master` or a `release/*` branch and is **user-facing** MUST update the changelog in the **same PR**. A change is user-facing if a user can see or do something different: actions, modes, sub-actions, settings, Race Engineer callouts, icons, behavior, or the website. Add the entry under the in-development version (see below).

Pure internal work (refactors, build/tooling, dependency bumps) with no user-visible effect may be summarized under **Maintenance** if notable, or omitted entirely. Don't list internal churn line-by-line.

## The in-development version section

Entries accumulate under the **top** `##` heading — the next unreleased version (the `version` in the root `package.json` with any `-dev` / `-rc` suffix stripped). If that version's section doesn't exist yet, create it at the very top of the list (the list is strictly newest-first). Leave its date line as `_Unreleased_`; **set the real `_YYYY-MM-DD_` by hand when you cut the release** — the release tooling (`release-it` + `scripts/release-hooks.mjs`) bumps `package.json` / `manifest.json` versions but does **not** touch `changelog.mdx`, so nothing stamps the date automatically. Automating this is tracked in #690.

Pre-release versions (`-alpha` / `-beta` / `-rc`) get **no** section of their own — fold their notes into the eventual stable version's section.

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
