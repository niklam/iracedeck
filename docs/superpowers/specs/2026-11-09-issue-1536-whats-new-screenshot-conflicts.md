> **Issue:** [#1536](https://github.com/niklam/iracedeck/issues/1536) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Settings-window screenshots are captured by the stable release, never in a branch

The issue carries the problem: every user-facing PR recaptures `whats-new.png`, a binary file git cannot merge, so any two in flight conflict. It is #1386's shared-file conflict back again.

This spec decides that **all eleven** Settings-window screenshots are captured once, by the stable release, into its version-bump commit. Only the release path can write the committed folder. A manifest beside the PNGs records what was captured, and a test holds the committed set to it.

## What the 3.9.0 branches show

There are two sources of conflict, not one. Measured on `feature/1112-…`, `feature/1161-…` and `feature/1599-…` against `origin/master` at `efa6e37ac`:

- **The What's New tab.** Its shot shows the top of the in-development section, so it differs on every branch that has a fragment: three branches, three different `whats-new.png` blobs.
- **The header version, on every tab.** The window header prints `v<version>` (`settings-window.ejs`, `sw-version`).
  - `master`'s PNGs were captured at `v3.8.1-dev.0`, and `master` has been `3.9.0-dev.0` since 2026-11-08. So every recapture rewrites all eleven files.
  - Where a branch only re-dated a tab, #1112 and #1599 wrote byte-identical blobs (`delays`, `simhub`, `key-bindings`, `support`, `getting-started`, `profiles`, `race-engineer`), and identical changes merge.
  - A tab that one branch really changed still conflicts with the other branch's re-dated copy. #1112 changed `diagnostics.png` while #1599 re-dated it. #1599 changed `general.png` and `appearance.png` while #1112 re-dated them. That is three conflicts, and none of them is on What's New.

The issue scopes out the other screenshots as changing "only with the UI". The second item shows that this does not hold: after every version bump, the first recapture on each branch touches all eleven files. A fix for What's New alone would leave #1112 and #1599 conflicting.

## Decision

### 1. The stable release captures every screenshot

A new release-it `after:bump` hook, `scripts/release-capture.mjs`, does the capture. Its logic lives in `scripts/lib/release-capture.mjs` with every collaborator injected, the same shape as `capture.mjs`.

It runs after `before:bump` has folded the fragments and bumped the version files, and before release-it commits. It runs only for a version with no prerelease identifier, the same condition as the fold, because `release.yml` deploys the website only for such tags (`!contains(github.ref_name, '-')`).

The hook takes these steps in order:

1. **Refuses a developer tree, before building.** That is a tree where `feature-flags.local.json` or `dev.local.json` exists at the root, or where `IRACEDECK_DEV_VOICES` is set. Either would build flags or a voice root that no user has into the shot.
2. **Snapshots what `before:bump` left.** Records each tracked change already in the tree (the version bumps, the fold) with its content hash, so step 7 can tell the hook's own changes from the build's. (Amended 2026-11-09: comparing against HEAD would refuse `before:bump`'s own changes.)
3. **Builds the Stream Deck plugin and its dependencies** with `pnpm_config_verify_deps_before_run=false turbo run build --filter=@iracedeck/iracing-plugin-stream-deck... --output-logs=errors-only`. The variable is needed because `before:bump` rewrites every workspace `package.json` version, which pnpm's `verifyDepsBeforeRun: install` reads as dependencies out of date, so every task would reinstall at once (QA saw one `ERR_PNPM_EXECUTOR_SPAWN_LIFECYCLE` in six releases). `--output-logs=errors-only` keeps a successful build inside release-it's 1 MiB `exec` buffer, and a failed build repeats its last 200 lines on stderr, which is all release-it shows on a failure. (Amended 2026-11-09 from QA.) This makes `ui/settings-window.html` carry the folded notes and the new version.
   - Because the bumped `package.json` is among their turbo inputs, this also rebuilds `iracing-native` and `audio-native`. A stable release therefore needs the native toolchain (Visual Studio, node-gyp) as well as a Chromium browser.
   - An MSVC `LNK1318` abort is a toolchain hiccup: the remedy is to restore and rerun the release.
4. **Runs `assertReleaseBuild`** (`scripts/lib/assert-release-build.mjs`) on the built plugin's `bin/config.json`, as a second, built-artifact check that no development voice root got in.
5. **Captures into `packages/website/src/assets/settings-window/`** with one new option, `expectVersion`. Before the first shot, the capture reads `.sw-version` over CDP and refuses a page that does not say `v<version>`. That catches a stale build before it is committed, for example a turbo hit that missed the bump.
6. **Writes `capture.json`** (see section 3).
7. **Refuses any other tracked change.** If the build changed a tracked file outside that folder, compared with the step 2 snapshot, the hook refuses, because release-it's commit would otherwise sweep it in unseen. Otherwise the hook stages the folder.

Any failure aborts the release before the commit, with a message naming `git restore --staged --worktree -- :/` and, for a screenshot written for a tab that had none, `git clean -fd -- packages/website/src/assets/settings-window/` (amended 2026-11-09: a restore does not remove an untracked file). release-it arms its own rollback only in `beforeRelease`, after `after:bump`, so these commands are the only remedy. That restore is safe because release-it's `requireCleanWorkingDir` held at the start.

A Support tab skipped for its image (rule 7 of `website-screenshots.md`) is a failure here too. A release already needs the network to push and to create the GitHub release, so a rerun is the remedy, and a partial set would put the previous version's header on the site.

### 2. Only the release path writes the committed folder

The rule that branches never commit a screenshot is enforced by where the tools write, not by a version check.

A version check could not do it. On `release/*`, a fix PR builds a stable version: `release/3.6` went v3.6.0, then PR #1462, then v3.6.1, with no `-dev` in between. A branch capture there would pass every version rule.

So `pnpm capture:settings` writes to `local/settings-window-capture/`, which is gitignored by the root `local/*` entry, and never writes `capture.json`. It stays a way to look at a change. Only `release-capture` passes the committed folder as `outDir` and writes the manifest.

In-flight branches that already committed a recapture drop it when they rebase, with `git checkout origin/master -- packages/website/src/assets/settings-window/` plus `git rm` of each PNG the branch added that `master` lacks, which a checkout never deletes (amended 2026-11-09). The manifest test below turns their recapture red until they do, because the hashes no longer match.

### 3. `capture.json`

`capture.json` sits beside the PNGs:

```json
{ "version": "3.9.0", "files": { "<file>": "<sha256>" } }
```

Only `release-capture` writes it, with `JSON.stringify(…, null, 2)` plus a newline, which Prettier accepts. `version` is the version the header printed.

It makes "captured by a release" checkable in text, which the PNGs are not: rule 3 of `website-screenshots.md` already says images cannot be compared across machines.

### 4. Adding and removing a tab

**Adding a tab** must still work in a branch, which cannot commit the tab's PNG. `tabs.test.mjs` already forces the tab into `SETTINGS_WINDOW_TABS`, so the system tolerates a tab that is listed but not yet captured:

- **The manifest check** accepts a listed tab that has neither a file nor a manifest entry, as "pending the next release capture". Every other mismatch stays red:
  - a file without an entry;
  - an entry without a file;
  - a hash that does not match;
  - a file or entry for a tab that is not listed.
- **`settings.md` renders its shots through a component, `SettingsShot.astro`.** It resolves the folder with `import.meta.glob("…/settings-window/*.png", { eager: true })` and renders nothing for a tab that has not been captured yet. Today's Markdown image imports fail the Astro build when the file is missing, which would make the docs section unbuildable until a release.

**Removing a tab** deletes its PNG and its manifest entry in the same commit. That is the one hand edit allowed to the folder, and the check names it when only one half is gone.

### 5. Dry run

`pnpm release:dry` runs the hooks itself (#1667), so `scripts/release.mjs` also runs this step's dry branch. That branch makes the developer-tree checks, prints the build and capture it would do, and writes nothing.

### 6. Back-merges

A `release/x.y` patch release recaptures on its branch. In the back-merge, PNG and `capture.json` conflicts resolve to the side whose `capture.json` version is higher, taking the whole folder, never mixing files.

When `master` has not released since the branch point, the release branch's set is newer and arrives without a conflict, since only releases touch the folder.

### What readers see between releases

Between releases, `master`'s screenshots show the last release, while its pages may already describe newer UI. No reader sees that state: the site ships from stable tags only, and at a tag the two agree. That is the same property the fold gives the changelog.

## Alternatives rejected

- **Capturing inside `release-hooks.mjs` (`before:bump`).** The issue's constraint is real but narrower than it looks. The hook is a plain Node process that can spawn a browser, as `capture-settings-window.mjs` does. What it cannot do is capture what ships: at `before:bump` time the build still carries the old version and the unfolded notes, so the build has to come after the bump. A separate `after:bump` hook keeps the fold's plan-then-write ordering and its tests untouched.
- **A fixed fixture changelog.** The notes are compiled into `settings-window.html` at build time (`settings-window-changelog.ejs` requires `./data/changelog.json`). A fixture would need one of two things:
  - a second, capture-only plugin build with fixture data, which means a new build variant and new turbo wiring;
  - CDP rewriting `#sw-changelog`, which breaks the harness's "honest" property and re-implements the partial's markup in the harness.

  Either way the website would show invented release notes. The `9.9.0` "not installed" card already shows invented content, but as a labelled example of a feature, not as the notes. And neither way fixes the header-version conflict on the other ten tabs.
- **Recapturing on `master` after merge, in CI.**
  - CI's Linux Chromium renders other fonts than the Windows window users see (rule 3's cross-machine caveat).
  - A bot cannot push past `Protect master`, so every merge would need a bot PR, spending CodeRabbit's shared allowance (#1649) or an `--admin` merge.
  - Concurrent merges would race.
  - Doing it locally instead is a direct `master` commit, which needs Niklas, and it serialises every merge behind a browser run.
- **Generating the PNGs at website deploy, gitignored.** This has the same Linux-rendering problem. It adds a plugin build and the Support image's network fetch as new ways for the deploy to fail. And `pnpm dev` would have no images.
- **Pinning or blanking the header version in branch captures.** This edits the DOM the harness exists to capture faithfully, and it leaves What's New conflicting.
- **A version rule alone guarding branches.** As section 2 shows, `release/*` fix PRs build stable versions, so this rule cannot tell a branch capture from a release capture. The guard has to be structural.

## Testing

### Automated

**`scripts/lib/settings-window-capture/capture-manifest.mjs`.** A pure `checkCaptureManifest({ manifest, files, tabs, newestReleased, packageVersion })` returns findings. `capture-manifest.test.mjs` runs it on the real tree, so it runs in `pnpm test` and CI with no browser. The rules:

- **Listing.** Every listed tab has a file and an entry, or neither (pending). There is no file or entry for an unlisted tab.
- **Hash.** Each entry's sha256 equals the file's bytes.
- **Version window.** `version` is:
  - stable semver;
  - at least the newest dated section of `changelog.mdx`, read through `changelog-parse.mjs`, which catches a release whose capture never landed;
  - at most the root `package.json` version with its prerelease stripped.

Each finding names its fix: drop the branch's files, delete the half-removed tab's remainder, or recapture at the release.

**Positive controls, in the same file.** Each mutated input must produce its finding:

- one flipped byte in a PNG;
- a file without an entry;
- an entry without a file;
- a PNG for an unlisted tab;
- a `-dev` version;
- a version below the newest dated section;
- a version above the package version.

A listed tab with neither file nor entry must produce none. A check that cannot fail proves nothing.

**`release-capture.test.mjs`,** with injected filesystem, environment, build, release-build assertion, capture, git and log:

- On a stable version, the steps run in order: developer-tree check → snapshot → build → `assertReleaseBuild` → capture → manifest → tracked-file check → stage.
- A prerelease or `-dev` version does nothing.
- Each of `feature-flags.local.json`, `dev.local.json` and `IRACEDECK_DEV_VOICES` refuses before the build runs.
- A built `bin/config.json` carrying `devVoicePacksRoot` refuses before the capture runs.
- A failure at each step stops before staging and names `git restore --staged --worktree -- :/` and the `git clean` of the screenshot folder.
- A header-version mismatch is refused.
- A tracked file changed by the build is refused.
- The dry branch writes nothing.

A wiring test asserts that `.release-it.json` names the hook under `after:bump`. Its positive control is a copy of the config without the hook, which must fail.

**Other tests:**

- `capture.test.mjs` gains the `expectVersion` refusal.
- The composition-root test asserts that `pnpm capture:settings` resolves its output under `local/` and writes no `capture.json`.
- `release.test.mjs` covers the dry-run call.
- A website test builds a stub page with `SettingsShot` naming a tab that has no file, and the build must pass and render no `<img>`.

### Bootstrap

The exemption holds while the newest dated section of `changelog.mdx` is older than `3.9.0` (`FIRST_CAPTURED_RELEASE`), the first stable release cut with the capture hook, not on any version string; a 3.8.x hotfix back-merge keeps it. (Amended 2026-11-09 after the second read: keying on exactly `3.8.1` would turn master red after a 3.8.2 back-merge.) While that holds, the check skips the three version rules and keeps the listing and hash rules.

This handles a mixed folder whichever order things land in. #1112, #1161 and #1599 may merge before #1536, leaving `master`'s PNGs captured at different `-dev` versions.

The implementing PR commits `capture.json` with hashes computed at its final rebase onto `origin/master`, and recaptures nothing. The 3.9.0 release folds a `3.9.0` section, which ends the exemption, and in the same commit it recaptures the whole folder at `3.9.0`, so the version rules apply from then on. A follow-up deletes the exemption.

### Manual (dev tooling, so the issue's `qa` agent runs it, per #1532)

Run in a throwaway clone, with no push, no tag and no GitHub release:

1. `pnpm release:dry 9.9.0` prints the build and capture it would do, and the clone stays clean.
2. Run both hooks for `9.9.0` with release-it's commit suppressed (`--no-git.commit --no-git.tag --no-git.push --no-github.release`). Check that:
   - the eleven PNGs and `capture.json` are staged;
   - the headers read `v9.9.0`;
   - What's New shows `9.9.0` with today's date and badged Installed;
   - `capture-manifest.test.mjs` passes.
3. `pnpm capture:settings` writes only under `local/`, and `git status` stays clean.
4. Two scratch branches off `origin/master`, each adding a fragment and touching one settings tab's partial, produce no conflict on the settings-window folder under `git merge-tree --write-tree`.
5. A scratch branch adding a tab to `SETTINGS_WINDOW_TABS` with no PNG passes `capture-manifest.test.mjs`, and `pnpm --filter @iracedeck/website build` passes. Copying a PNG into the folder by hand turns the test red.
6. With a `dev.local.json` present, the capture hook refuses before building. With the browser path made unresolvable, it aborts before the commit and prints the restore command, which returns the clone to clean.

## Rules and docs that change

- **`website-screenshots.md`:**
  - *Regenerating*: the stable release captures, `pnpm capture:settings` writes under `local/` for looking only, and the developer-tree refusal.
  - *Rule 3*: adding a tab leaves it pending until the next release capture, and `SettingsShot` renders nothing for it until then. Removing a tab deletes its PNG and its manifest entry together.
  - *Rule 4*: the header shows the release version.
  - *Rule 7*: a Support skip fails the release step.
  - *Layout*: `capture.json`, `SettingsShot.astro` and the two new scripts.
  - `paths`: the new scripts.
- **`changelog.md`:** "A fragment added or edited makes the Settings window screenshot stale" becomes "a fragment never needs a recapture; the stable release captures the screenshots".
- **`changelog-internals.md`:** one line under *The fold at a stable release*. The `after:bump` capture follows the bump. A stable release therefore needs a Chromium browser and the native toolchain, since the build rebuilds `iracing-native` and `audio-native`. An MSVC `LNK1318` abort means restore and rerun.
- **`build-and-commit.md`:** *Releasing* gets the capture step. *Back-merging* gets the higher-version-wins rule for the screenshot folder.
- **`.claude/agents/documenter.md`:**
  - the documenter no longer recaptures screenshots;
  - a new tab is placed with `SettingsShot`.
- **`.claude/CLAUDE.md`:** the `website-screenshots.md` index line.
- **`scripts/CLAUDE.md`:** the release section.
- **`README.md`:** *Releasing* gets the new step and its requirements: a Chromium browser, the native toolchain, and `LNK1318` meaning rerun.
- **`docs/getting-started/settings.md`:** its eleven Markdown images become `SettingsShot` calls. This needs `.md` → `.mdx`, so check inbound links when renaming.
- **No hook.** The guard is where the tools write, plus the manifest test in CI.

## Out of scope

- How the capture renders: fixture, viewport, locale (rule 6), and the Support image's moving count.
- Making a capture byte-reproducible across machines.
- Other committed binaries, such as `packages/icons/preview/`, which are already freshness-tested.
- Running the release itself in CI.
- Changing what the What's New tab shows.
