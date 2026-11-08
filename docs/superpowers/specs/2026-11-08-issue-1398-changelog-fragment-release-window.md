> **Issue:** [#1398](https://github.com/niklam/iracedeck/issues/1398) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Fragments merged after a stable fold compose as an Unreleased section

The issue carries the problem: between a stable bump and the next version bump, the root `package.json` names a version whose `## X.Y.Z` section is already dated, so a fragment merged in that window makes the composer throw and every reader fails. Niklas decided the fix on 2026-11-08 (issue comment): the readers tolerate the window, pending fragments compose as an Unreleased section, the next stable fold takes them, and the release run does not bump `-dev` itself. This spec settles how. It changes one compose-time rule of the #1386 design (`2026-10-10-issue-1386-changelog-fragments-merge-gate.md`), which stays the record of everything else.

## Two explicit modes: preview and fold

Today `composeChangelogParts(mdx, fragments, version, dateLine)` tells a preview from a fold only by the date line it is handed. Once a preview can write a section with no date line at all, that argument would be a mode flag whose value is no longer what gets written, so the mode becomes explicit: `composeChangelogParts(mdx, fragments, version, mode)` and `composeChangelog` likewise, where `mode` is `{ mode: "preview" }` or `{ mode: "fold", date }` (`date` as `YYYY-MM-DD`). Both modes run one shared core (the `_Unreleased_` / `## Unreleased` check, the two duplicate-bullet checks, the render and the splice); only the version rules differ.

- **Preview** (`readComposedChangelog` in `changelog-composed.mjs`, `changelogFragmentSection` in `packages/website/src/changelog-fragments-plugin.mjs`): `version` is the root `package.json` version, stripped, and the three states below apply.
- **Fold** (`planChangelogFold` in `changelog-fold.mjs`): `version` is the release version release-it passes to the hook, not `package.json`, and today's single rule over it stands: a `## <version>` section anywhere refuses, and the section is `## <version>` / `_<date>_`. None of the three states applies; a release version behind the newest section is still refused by `buildChangelogData`'s newest-first check, as today.

`UNRELEASED_DATE_LINE` stays as the date line the preview writes in the first state; it is no longer a parameter.

## The three states of a preview

Let `V` be the in-development version (root `package.json` with any `-…` suffix stripped, as today) and `N` the version of the newest `## ` section in `changelog.mdx`. While `changelog.d/` holds fragments and the composer is previewing:

| State | Example | Composed section |
| --- | --- | --- |
| `V` newer than `N` (the normal case) | `3.9.0-dev.0` over `## 3.8.1` | `## 3.9.0` / `_Unreleased_`, unchanged from today |
| no `## ` release heading at all (no `N`) | a `changelog.mdx` with only its preamble | `## V` / `_Unreleased_` appended after the preamble, unchanged from today |
| `V` equals `N` (the window) | `3.8.1` over `## 3.8.1` | `## Unreleased`, no date line (new) |
| `V` older than `N`, or `V` has a dated section that is not the newest | `3.8.1` under `## 3.9.0` | refused (below) |

With no fragments nothing is composed in any state, exactly as today, so the release commit itself (`V` = `N`, fragments just deleted) still reads cleanly.

The window is recognised by `V` equalling the **newest** section, not by `V` having a section anywhere. A tree whose version is behind a released one is misconfigured (a missed bump, or a bad merge), not a window, and tolerating it would put an Unreleased card above a release the tree has never seen.

## The window section's exact text

```markdown
## Unreleased

**Features**

- The bullet text.
```

The heading is the literal `Unreleased`, exported as one constant from `scripts/lib/changelog-parse.mjs` (the module that owns the format) and imported by the composer. There is no date line: the heading already says it, and `_Unreleased_` under it would print the word twice on the page and in the pane. Categories, order and bullets are rendered by the same `renderReleaseSection` as every other section, which accepts the label in place of a plain version and then writes no date line. It is inserted before the first `## ` heading, as today.

A version number is deliberately not invented. The next version is unknown in the window (a hotfix makes it `X.Y.Z+1`, the next feature release `X.Y+1.0`), and guessing it is the next-version policy Niklas's decision avoids.

## How each reader renders it

- **Parser (`changelog-parse.mjs`).** Accepts a `## Unreleased` heading only as the first release, at most once, with no date line of any kind (a `_YYYY-MM-DD_` or `_Unreleased_` line under it is an error), and with the usual category and bullet rules. It yields `{ version: "Unreleased", date: null, categories }`. The newest-first check starts from the release below it. Every other heading must still be a plain `X.Y.Z`.
- **`changelog.json` (plugin What's New data and the website's published copy, both through `changelog-composed.mjs`).** The first release is `{ "version": "Unreleased", "date": null, … }`. The published copy **can** carry it: `firebase-hosting-release.yml` checks out `inputs.ref || github.ref`, so a manual dispatch from `master` or a `release/*` branch inside the window deploys a site whose `changelog.json` holds the section. The safety argument therefore rests on the undated filter, not on which ref deploys. The shape does not change: `version` stays a string and `date` stays nullable, which is all `ReleaseSchema` in `packages/app-updates/src/published-changelog.ts` requires, so every already-shipped plugin parses the artifact. And `selectAvailableUpdates` in `update-check.ts` drops any release for which `isPublished(date)` is false before its version is read as semver, so the label is never offered as an update and never compared with `semver.gt`. This is the same path today's `## X.Y.Z` / `_Unreleased_` release takes through a published copy built from a non-tag ref.
- **Settings window pane (`packages/pi-components/partials/settings-window-changelog.ejs`).** Renders the card with `Unreleased` as its title and no date chip: the chip's top-of-list "Unreleased" fallback is skipped when the version is the label, so the word is not shown twice. EJS cannot import the constant, so the partial compares against a hand-kept `'Unreleased'` literal, pinned by its test building the fixture from the exported constant (Testing). The Installed badge is unchanged: a build of a window tree reports `X.Y.Z`, whose dated section is right below, and is badged there. `<ird-update-notice>` inserts newer published releases before the first card as today; its de-duplication by version text never matches the label.
- **Website changelog page (`packages/website/src/changelog-fragments-plugin.mjs`).** Splices the section in as today; Starlight lists it in the table of contents as "Unreleased" with the anchor `#unreleased`.

## What still throws

- **A hand-written `## Unreleased` heading in `changelog.mdx`**, with or without fragments, refused by `assertNoInDevelopmentSection` beside the `_Unreleased_` line it already refuses. The label exists only in composed text, so the parser's acceptance of it can never be reached from the file.
- **`V` behind the newest section** (last row of the table), refused by a preview while fragments exist, naming both versions and the line: today this surfaced only as the parser's newest-first error on the composed text, or, for `V` dated below the top, as the existing-section error.
- **The fold, on an existing section.** In fold mode a `## <release version>` section anywhere still refuses, as today. This is the guard `release-hooks.mjs` relies on to refuse a re-run over a half-folded tree; its message changes from "bump the version to the next -dev first", which is wrong advice for a fold, to naming the half-folded tree and the `git restore` the hook prints. A stable release always bumps to a new version, so a legitimate fold never meets it.
- **A fragment repeating a dated bullet**, unchanged and now load-bearing in the window too: a half-folded tree read by a build (folded `changelog.mdx`, fragments still on disk, version files not yet bumped) is exactly the window's shape, and it is refused because every fragment repeats a bullet of the section just written, rather than composed as an Unreleased duplicate.
- **Two fragments with the same bullet**, unchanged.

## The fold after the window

Unchanged. The next stable bump, whichever version it names, composes every fragment into its own dated `## <version>` section and deletes them; the window section is never written to a file. On `master` that is usually after the next `-dev` bump, whose root version is newer than `N`, so the fragments return to the first row of the table as `## <next> _Unreleased_` with no edit. On a `release/X.Y` branch, a hotfix fragment merged after the `X.Y.Z` fold shows as Unreleased until `X.Y.Z+1` folds it; the back-merge then brings `master` the dated section and the deletion, as #1386 describes.

The most common way `master` enters the window is a back-merge, not its own release. `master` at `X.Y.0-dev.0` takes `release/X.Y`'s `## X.Y.0` fold; the version conflict resolves in `master`'s favour (`build-and-commit.md`), so `V` is `X.Y.0` and equals the new `N`. The fragments `master` gained after the branch point survive the merge and compose as `## Unreleased` until `master`'s next version bump or stable fold takes them. Under the old rule this back-merge alone turned `master` red.

## Alternatives rejected

- **The release run bumps to the next `-dev` itself** (the issue's first option). It needs a policy for the next version (patch or minor), which is not knowable at release time and which the maintainer would then have to override by hand. It does not cover a hotfix fragment on a `release/*` branch unless the branch is bumped to a `-dev` too, which the release branches do not do. And it only shrinks the window to the time between two commits of one run, while a declined or failed step still leaves it open.
- **Compose the window under a guessed `X.Y.Z+1`.** Invents a version that is often wrong, badges and anchors it as if real, and renames the section when the real bump lands.
- **Fold the fragments into the dated `## X.Y.Z` section in the preview.** States that the changes shipped in a release that does not contain them.
- **Keep the version heading and only drop the duplicate check** (`## X.Y.Z` / `_Unreleased_` above the dated `## X.Y.Z`). Two sections for one version: the parser refuses the duplicate, the pane would badge the wrong card and the page would carry two `#xyz` anchors.
- **Skip the fragments in the window.** Every build goes green, but the notes vanish from the page and the pane until the bump, silently.

## Out of scope

- Whether a stable release should still be followed at once by a `-dev` bump. It stays the README's normal procedure; it is simply no longer what keeps `master` green.
- The Installed badge in a window build: the build reports `X.Y.Z` while carrying unreleased changes. Only development builds of a window tree are ever in that state.
- Automating the bump or the board's `Done` step in the release hooks.
- A `master` ↔ `release/*` sync that leaves a branch's version behind its newest section: refused as before, now with a clearer message.
- Any change to the fragment file format, the fold's validation, `changelog.json`'s schema or the website's deploy refs.

## Affected artifacts

- `scripts/lib/changelog-parse.mjs`: the label constant and the `## Unreleased` acceptance rules.
- `scripts/lib/changelog-fragments.mjs`: the explicit `mode` on `composeChangelogParts` / `composeChangelog` over one shared core, the three preview states, the window section, the behind-the-newest refusal, the `## Unreleased` check in `assertNoInDevelopmentSection`, the fold message; `renderReleaseSection` accepting the label.
- The three callers move to the explicit mode: `scripts/lib/changelog-composed.mjs` and `packages/website/src/changelog-fragments-plugin.mjs` pass `{ mode: "preview" }`, `scripts/lib/changelog-fold.mjs` passes `{ mode: "fold", date }`.
- `scripts/release-hooks.mjs`: comments on the re-run guard; no behaviour change.
- `packages/pi-components/partials/settings-window-changelog.ejs`: the date chip skips the label.
- Comments that describe the in-development release: `packages/app-updates/src/published-changelog.ts`, `update-check.ts`, `packages/website/src/changelog-fragments-plugin.mjs`, `scripts/lib/changelog-composed.mjs`.
- `.claude/rules/changelog.md` (the in-development section can be `Unreleased`; a hand-written `## Unreleased` fails every reader), `.claude/rules/changelog-internals.md` (the drift list and the dated-section format), `.claude/rules/build-and-commit.md` *Releasing* (drop the collision sentence and the #1398 pointer), `changelog.d/README.md` (the window sentence), `README.md` *Releasing* step 1 (fragments merged after a stable bump show as Unreleased and fold into the next stable release).
- `packages/app-updates/CLAUDE.md` (its `update-check.ts` bullet names the `_Unreleased_` release; it becomes "an undated release", which covers both) and `scripts/CLAUDE.md` (the `changelog-fragments.mjs` and `release-hooks.mjs` descriptions: the two compose modes and the window).
- No changelog fragment: nothing a user of a released build can see changes. No Architecture page change.

The diff changes the changelog format, its parser and composer, so `/code-review` runs at `xhigh` (`code-review.md`), and the composer's refusals are a guard, so the second read applies.

## Testing

Each new test that composes a window tree (the fragments, composed, website-plugin and release-hooks cases) is written first and run against today's code, where it must fail with the `section already exists` error; the parser cases fail there on the non-version heading. That red run is the positive control, recorded in the PR body. The `app-updates` cases pin behaviour that already holds and are expected green on today's code; they guard the safety argument against a later change to the filter.

- `changelog-fragments.test.mjs`: a preview of the window composes `## Unreleased` with no date line before the first heading, and the composed text parses to `releases[0]` `{ version: "Unreleased", date: null }` above the dated release; the first row is unchanged, and so is a `changelog.mdx` with no `## ` heading (the section is appended after the preamble); `V` behind the newest section, with and without a section of its own, is refused naming both versions; a fold over an existing section still throws, with the new message, and a fold never writes `## Unreleased`, whatever `package.json` says; a half-folded tree in preview throws "already in a released section"; a hand-written `## Unreleased` is refused with and without fragments, in both modes. The existing test "refuses an existing section for the in-development version while fragments exist" becomes the window test, and its fold-mode half stays a refusal.
- `changelog-parse.test.mjs`: `## Unreleased` accepted first; refused when not first, twice, with a dated or `_Unreleased_` date line, or with no categories; the release below it is still order-checked against the one below that.
- `changelog-composed.test.mjs` and `packages/website/src/changelog-fragments-plugin.test.ts`: a fixture tree with `package.json` at `1.2.0`, a dated `## 1.2.0` and one fragment yields the Unreleased release and the Unreleased page section.
- `settings-window-changelog-partial.test.ts`: the fixture's first release takes its version from the label constant exported by `scripts/lib/changelog-parse.mjs`, never a literal, so a drift between the constant and the partial's `'Unreleased'` fails; it renders its title, no date chip and no badge, and the badge sits on the dated installed release.
- `packages/app-updates/src/published-changelog.test.ts`: an artifact whose first release is `{ version: <label constant>, date: null }` parses. `update-check.test.ts`: `selectAvailableUpdates` never returns that release, whatever the installed version, including beside a dated release newer than the installed one, which it does return.
- `release-hooks.test.mjs`, in the git fixture, three sequences:
  - **The window on `master` after its own release:** release `1.0.0` (fold), commit a fragment with the version still `1.0.0`, compose without error, then release `1.0.1` and see the fragment folded into a dated `## 1.0.1` with no `Unreleased` written anywhere.
  - **A hotfix on a release branch:** the same sequence on `release/1.0`, back-merged into a `master` at `1.1.0-dev.0` that holds its own fragment, leaves `master` composing `## 1.1.0` / `_Unreleased_` above `## 1.0.1`.
  - **A back-merge putting `master` in the window:** `master` at `1.1.0-dev.0` cuts `release/1.1`, gains a fragment after the branch point, then takes `release/1.1`'s `## 1.1.0` fold through a regular merge with the version conflict resolved to `master`'s `1.1.0-dev.0`; `master` then composes its post-branch-point fragment as `## Unreleased` above `## 1.1.0`, and its next stable release folds it into its own dated section.
  - The existing half-folded re-run test passes unchanged.
- Manual test (dev tooling, so the `qa` agent runs it for real in the worktree): set the root version to the newest dated one, add a scratch fragment, run `pnpm generate:changelog-data` and `pnpm --filter @iracedeck/website build`, and show the `Unreleased` entry in `changelog.json` and on `/changelog/`; run `pnpm release:dry` for the next patch and show the fragment folded into that version's dated section; then restore the tree. The rendered page and the settings window pane in that state go to Niklas as the part he sees.
