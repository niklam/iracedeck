# Build & Commit Conventions

Build

- Install and build with pnpm: `pnpm install` then `pnpm build` (or package-specific build scripts).
- Useful shortcuts:

```bash
pnpm build:ts               # Build all TypeScript (excludes native addon)
pnpm build:native           # Build native addon only
pnpm build:with-restart     # Build all packages, stop/restart Stream Deck around it
pnpm build:stream-deck      # Build TS + restart Stream Deck plugin
pnpm restart:stream-deck    # Restart Stream Deck plugin
pnpm watch:stream-deck      # Watch mode with auto-restart
pnpm link:stream-deck       # Register plugin with Stream Deck
pnpm unlink:stream-deck     # Unregister plugin from Stream Deck
pnpm relink:stream-deck     # Unlink + link (useful when switching worktrees)
```

### Dependency build scripts

pnpm runs no dependency's `preinstall` / `install` / `postinstall` unless the package is named, so every dependency that has one is an explicit decision in `allowBuilds` in `pnpm-workspace.yaml` (#1176, #1245). Since pnpm 11 an undeclared one fails the install with `ERR_PNPM_IGNORED_BUILDS` rather than printing a notice, so a new dependency with a script is decided in the same change that adds it — and a Dependabot bump that pulls one in stays red until the entry is added on its branch. `true` is for a script something here needs: `ffmpeg-static`, whose install downloads the ffmpeg binary the voice-clip radio pipeline runs. `false` declines the rest, and each entry has a reason:

- `esbuild` (via `tsx`, `vite`): the script only re-fetches the platform binary when the optional `@esbuild/<platform>` package is missing, which pnpm installs, and swaps the JS shim for the binary off Windows, a speed-up nothing relies on.
- `protobufjs` (via `firebase-tools`): the script only prints a version-scheme advisory.
- `re2` (via `firebase-tools` → `superstatic`, an optional dependency): a native `node-gyp` build. `superstatic` falls back to `RegExp` without it, it is only used by `firebase serve` / the emulators, and `firebase.json` has no `regex` rules.

### The pnpm version and its settings

pnpm is pinned to one exact version (12.6.0 since #1245): `packageManager` in the root and the five packages that carry one, and `version` in the six workflows that run `pnpm/action-setup` on the commit they were triggered for. Move them together — the action refuses a `version` that differs from the root `packageManager` — and let `pnpm install` rewrite the lockfile, which records the pnpm version too. The seventh, `firebase-hosting-release.yml`, reads the pin from the ref it checked out instead: a voice-pack publish runs it from `master` against the latest stable tag, which may pin an older pnpm. Every workflow passes `version` explicitly rather than letting the action read `packageManager` itself, because that path once corrupted the lockfile (#386). A pnpm 10 or later on PATH switches to the pinned version by itself.

Since pnpm 11 every pnpm setting lives in `pnpm-workspace.yaml`. The `pnpm` field of `package.json` is not read, and `.npmrc` is read for auth and registry keys only — a setting put in either is dropped without a word, which is how `save-exact` would have stopped applying. The reverse holds too: pnpm 12 fails every command on a key it does not recognise in `pnpm-workspace.yaml` (`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`), so a misspelling is caught. Two settings there are decisions rather than housekeeping:

- `saveExact: true` — `pnpm add` writes exact versions (`@.claude/rules/code-style.md`).
- `minimumReleaseAge: 1440` — pnpm's own default, written out: a version published less than a day ago does not resolve, so a compromised release has a day to be caught before it can land here. The cost is that a fix published today cannot be installed until tomorrow. When one cannot wait, name that package under `minimumReleaseAgeExclude` in the same change and drop the entry once the version is a day old — never lower the age itself. A one-off command-line override is no way round it: the lockfile is checked against the policy on every install, CI's frozen one included. Dependabot's `cooldown` in `.github/dependabot.yml` is set to the same day, so its bumps pass that check; change the two together.

Two more pnpm 11 defaults change what an everyday command does, and are left at their defaults:

- `verifyDepsBeforeRun: install` — `pnpm build`, `pnpm test` or `pnpm exec` in a tree whose dependencies are out of date (after a rebase, a manifest edit, or a change to `pnpm-workspace.yaml`) runs `pnpm install` first. The install → build order in the pre-commit checks still stands; this only means a skipped install no longer goes unnoticed.
- `blockExoticSubdeps: true` — a transitive dependency resolved from git or a tarball URL fails the install. The lockfile has none.

### Build verification

**Always review the full build output.** Since #987 every rollup build sets `noEmitOnError` (the plugins' shared config in `@iracedeck/plugin-build`, and `pi-components`' own), so a TypeScript diagnostic in a rollup-built package is a hard build failure rather than a warning on a green build — that is what the flag is for. Reading the output still matters, because a build can fail or misbehave for reasons that are not type errors.

- Run the build and capture all output (do not just check the exit code or tail the last few lines).
- Search the output for `TS[0-9]+:` patterns (e.g., `TS2345`, `TS2322`). Before #987 these could appear as *warnings* on a build that exited 0 and shipped broken output; they are now fatal, so finding one means the build failed.
- The plugin builds print no `(!)` line of Rollup's own: their shared log policy drops the known third-party noise (zod's and semver's internal cycles, zod's prose `@__PURE__` comments) and fails the build on a circular dependency among our own sources — see *Rollup Configuration* in `@.claude/rules/plugin-structure.md`. So a `(!)` from a plugin build is new and worth reading. So is `npm warn Unknown env config`: since #1205 the `bin/` install keeps only the `npm_config_*` keys npm itself defines, asking npm for the list (`scripts/lib/runtime-install-env.mjs`), so one appearing means that filter is broken, not that a key needs adding.
- Common cause: `vi.fn(() => null)` in test files infers return type as `null`, making `mockReturnValue({...})` a type error. Fix by widening the return type: `vi.fn((): Record<string, unknown> | null => null)`.

### Turbo task inputs and the CI cache

A file a build reads outside its task's hashed inputs — by default the git-tracked files of its own package, plus whatever `turbo.json` declares — is a stale cache hit with nothing red, locally and, since CI reuses the cache on PRs, in a green PR check. What must be declared, what `scripts/turbo-inputs.test.mjs` checks and how CI keeps the cache are in `turbo-cache.md` (#1491, #1492, #1501).

Branching & Worktrees

**All work happens in a sibling worktree and ends in a PR (#1044, #1520).** Never ask which work mode to use; work with no issue gets one filed first. Direct work on `master`, pushed without a PR, happens only when Niklas states it himself (specs aside, which always commit to `master`). See `@.claude/rules/issue-workflow.md` for the full pipeline.

### Worktree workflow

Worktrees are created as sibling directories of the main working tree (same parent directory), named `ir-<issue>`.

1. Create a worktree with a new branch:
   ```bash
   git worktree add ../ir-<issue> -b <type>/<issue>-<short-description>
   ```
2. Work inside the worktree directory.
3. Open a PR, get it reviewed and merged.
4. Delete the worktree after merge (see **Post-merge worktree cleanup** below).

### Format

`<type>/<ticket>-<short-description>`

### Types

- `feature/` — new functionality
- `fix/` — bug fixes
- `refactor/` — code improvements without behavior change
- `chore/` — maintenance, dependencies, config
- `hotfix/` — urgent production fixes
- `docs/` — documentation only

### Rules

1. Use lowercase with hyphens as separators
2. Always include the ticket/issue ID after the type prefix
3. Keep descriptions to 3-5 words in imperative mood
4. Use only alphanumeric characters and hyphens

### Examples

```
feature/123-user-authentication
fix/456-null-pointer-login
refactor/789-extract-payment-service
chore/012-upgrade-node-20
```

### Issue Linking

When committing or creating PRs, reference issues to enable auto-linking:

- `Fixes #123` — closes the issue when PR merges
- `Closes #123`, `Resolves #123` — same effect
- `Related to #123` — links without closing

### Avoid

- Generic names: `my-branch`, `test`, `wip`
- Ticket ID only: `123` (no context)
- Long descriptions: `feature/123-implement-the-new-user-authentication-flow-with-oauth2`
- Special characters other than hyphens

Committing

- Use Conventional Commits. Scope should usually be the package name.
- Do not reference Claude or other AI tools in commit messages.
- Do not add AI co-authors such as `Co-Authored-By: Claude Opus`.

### Pre-commit checks

Before every commit, the following must succeed:

1. **Install**: `pnpm install` — ensures dependencies are up to date.
2. **Build**: `pnpm build` — must complete without TypeScript errors (see **Build verification** above).
3. **Typecheck**: `pnpm typecheck` — the explicit type gate, and the same command CI runs.

Do not commit if any step fails. Fix the issue first.

**Why typecheck is separate from build.** Until #987 a green `pnpm build` said nothing about the type correctness of the rollup-built packages: `@rollup/plugin-typescript` reports type errors as rollup *warnings* and emits anyway unless `noEmitOnError` is set, so a build could report success while shipping a bundle that throws at startup. Every rollup build now sets `noEmitOnError` (the three plugins through their shared config in `@iracedeck/plugin-build`, `pi-components` in its own), which closes that at authoring time. `pnpm typecheck` is the explicit gate and is what a red CI run reproduces; see `@.claude/rules/testing.md` for what it does and does not cover.

### Logical Commits

Split work into logical, self-contained commits. Each commit should represent one coherent change that builds and passes tests on its own. This keeps the branch readable for review. Feature PRs are **squash-merged**, so these commits collapse into one commit on the target branch (the PR title becomes its message) — but the per-commit discipline is still what makes the branch reviewable, and branch-to-branch back-merges preserve full history (see **Merging**).

Guidelines:

- **One concern per commit** — don't mix a refactor with a new feature or unrelated fixes.
- **Commit as you go** — commit each logical step when it's complete, don't batch everything into one giant commit at the end.
- **Commit message = what and why** — the diff shows _what_ changed; the message should explain _why_.

Examples of good commit splits for a new action:

```
feat(actions): add FuelCalculator action and icons
feat(iracing-plugin-stream-deck): register FuelCalculator action and PI
feat(iracing-plugin-mirabox): register FuelCalculator action
test(actions): add FuelCalculator unit tests
docs: add FuelCalculator action documentation
```

Pull Requests

- When creating a PR, use the PR template at `.github/pull_request_template.md` as the body structure.
- Fill in all sections: Related Issue, What changed?, How to test, and Checklist.
- Mark checklist items as complete (`[x]`) or incomplete (`[ ]`) as appropriate.
- Use `N/A` for sections that don't apply (e.g., "Related Issue" for infra work with no issue).
- Build, test, and lint checks are handled by CI — they are not in the PR checklist.
- **Before creating a PR, the issue lead runs the code review without asking** (#1520): the `/code-review` skill at the level from the table in `@.claude/rules/code-review.md` — `xhigh` is not the default — pointed at the worktree that holds the work rather than `master`, then the second read where that rule says, then the CodeRabbit CLI round. The review reports only — never `--fix`; verify each finding and apply the ones that hold as your own edits before opening the PR.

### PR Labels

PR labels are used to categorize entries in GitHub's auto-generated release notes. A `pr-labeler` workflow automatically applies `type:` labels based on the conventional commit prefix in the PR title:

| PR title prefix | Label applied |
|-----------------|---------------|
| `feat(` / `feat:` | `type: feature` |
| `improve(` / `improve:` | `type: improvement` |
| `fix(` / `fix:` | `type: bug` |
| `perf(` / `perf:` | `type: performance` |
| `refactor(` / `refactor:` | `type: refactor` |
| `docs(` / `docs:` | `type: docs` |
| `ci(` / `ci:` | `type: ci` |
| `chore(` / `chore:` | `type: chore` |

The labeler runs when a PR is opened or its title is edited. If you change the PR title prefix, the new label is added (but the old one is not removed — remove it manually if needed).

Release notes categories are configured in `.github/release.yml`.

One more PR label is set by hand, at `gh pr create`: `no-coderabbit`, on a PR whose every file is Claude-facing prose, so CodeRabbit skips it (`@.claude/rules/code-review.md`).

Issues

Issue templates automatically apply labels (`bug`, `enhancement`). These are separate from the `type:` labels used on PRs for release notes categorization — do not manually add `type:` labels to issues.

### Issue labels: kind and area; priority on the board (2026-09-05)

Two more axes sit beside `bug` / `enhancement`, one value each, so the backlog can be sorted by what the work is and where it lands; how much it matters lives on the board (below), not in a label. `bug` / `enhancement` keep saying "user-facing fix" / "user-facing feature"; the `kind:` axis names the work that is NOT user-facing.

| Axis | Values | Who sets it |
|------|--------|-------------|
| `kind:` | `kind: hygiene` (housekeeping, no user-visible change: lint gaps, duplication, stale docs, renames), `kind: dev-experience` (harness, build, CI, rules, tooling for whoever works on the repo), `kind: research` (a spike ending in a decision, not a PR); omitted for user-facing work | The filer, at filing |
| `area:` | `area: race-engineer` (Race Engineer, radar, spotter, voice packs, callouts, audio), `area: actions` (actions, dials, key icons, profiles), `area: settings` (settings window, Property Inspectors, global settings, first run), `area: website`, `area: platform` (deck-core, adapters, plugins, native addons, build and release tooling, CI, process) — the area the WORK lands in, not the one mentioned | The filer, at filing |

Milestones keep saying *when*. `discord` (a mirrored Discord request), `breaking change`, `documentation` and `wontfix` are unchanged and orthogonal. The backfill over every issue, open and closed, was done on 2026-09-05; a new issue gets its `kind:` (when it has one) and `area:` at filing. Priority labels (`p1`–`p3`) existed for a few hours that day and were retired in favour of the board's lanes.

**The board.** The *iRaceDeck Roadmap* project (`https://github.com/users/niklam/projects/1`, `gh project … 1 --owner niklam`) is a view over the same issues, never a second record, and it is where priority lives. Its `Status` lanes are `Backlog` (fine to sit), `Planned` (this or next release), `Next` (the agreed order, top first), `In progress` (a worktree exists — through the manual test, the PR and the merge), `Testing` (merged to `master` but not yet in a stable release: the milestone is still open), `Done` (shipped: a non-pre-release release carrying it is published and its milestone closed) and `Dropped` (closed as not planned or duplicate). Every closed issue is on it too, with `area:` and `kind:` but no priority, so the board is the history as well as the plan. Hooks move a card into `Backlog` when its issue is filed, into `Planned` when it gets a milestone, into `In progress` when its `../ir-<n>` worktree is created and into `Testing` when its PR merges. When one reports it could not, move the card by hand with the hook's helper — `node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.setBoardStatus(<n>,'In progress',process.cwd())))"` from the repo root — never a raw `gh project item-edit`, which is refused; lanes need the `project` token scope (`gh auth refresh -s project,read:project`). The worktree hook moves only the issue the tree is named for: a second issue solved in the same tree gets its card, milestone and assignee by hand when the tree is created. Which cards go into `Planned` — what a release contains — is Niklas's call alone; an agent moves one there only on his word in the conversation, never on its own judgement (#1574). **An open issue with a milestone is never left in `Backlog`** (Niklas, 2026-11-01): a milestoned card found there is moved to `Planned` with the helper, which is carrying out that standing word. The PO keeps the order of a milestone he has planned at the top of `Next` (#1520); any other agent proposes a lane in conversation. An issue closed WITHOUT a merged PR is moved by whoever closes it: to `Dropped` for not planned or duplicate, to `Testing` in the rare case something shipped through a commit rather than a PR. **`Done` is a release step, not a merge step** — see *Releasing* below. How each move works, what the helpers refuse and why `Testing` is a hook are in `roadmap-board.md`, which loads with the board helpers and the post-bash hook.

**A new issue is proposed, then filed (#1547).** Niklas approves every new issue: an agent proposes it through the `file-issue` skill, which searches for duplicates and related work first, and files it, with its spec when one is due (`@.claude/rules/specs-and-plans.md`), only once he approves. His own request for an issue is the approval.

When creating issues, always include requirements for updating all affected artifacts beyond the code itself. If the change affects actions, features, or behavior described in any of these, the issue must list them:

- **All plugin packages** — the shared action list in `packages/plugin-runtime/src/actions.ts` (or a host extension's extras), manifest entries, and PI templates for every applicable plugin (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, `iracing-plugin-ulanzi`)
- **Website** (`@iracedeck/website`) — action descriptions, feature lists, action counts, and a changelog fragment in `changelog.d/` for any user-facing change — see `@.claude/rules/changelog.md`; and the developer **Architecture page** (`docs/development/architecture.md`) when the change touches package structure, the abstraction seams, data flow, or the dependency graph
- **Action documentation** (`docs/`) — action docs, keyboard shortcut tables
- **Skills** (`iracedeck-actions`, `iracing-telemetry`, etc.) — action/mode/sub-action listings
- **Rules and guidance** (`.claude/rules/`, `CLAUDE.md` files) — conventions, patterns, references

Merging

- Feature/fix PRs are **squash-merged** into their target branch via `gh pr merge --squash` — one commit per PR. This is the default for `master` and every other branch (`release/*` / integration branches included). The PR **title** becomes the squashed commit's message, so title discipline matters doubly (see the title rules below).
- **Branch-to-branch merges are NOT squashed.** Release-branch back-merges and the periodic `master` ↔ `release/*` syncs use a regular merge (`gh pr merge --merge`, or a local `git merge`) — squashing one would collapse the other branch's whole history into a single commit and re-introduce its entire diff, causing avoidable conflicts on the next sync. See **Back-merging a release branch** below.
- **PR titles must include the issue number** at the end in parentheses: `<type>(<scope>): <description> (#<issue>)`. Example: `feat(actions): add Camera Focus action (#42)`. Under squash-merge this title is the commit message that lands on the branch, so it must read as a complete commit subject — the hook refuses a `gh pr create` whose title is not in that form.
- **PR titles drive release notes.** The conventional commit prefix determines the release notes category via auto-labeling (see **PR Labels** above). Use the correct prefix so the change appears in the right section.
- Merging is performed manually or by automation, or by the agent driving the work once CodeRabbit has approved and checks are green (#1044) — but **never by a Claude review step**. Reviewing and merging stay separate hands.
- **Add a changelog fragment.** Any user-facing change merging to `master` or a `release/*` branch adds a fragment to `changelog.d/` in the same PR — or, when it refines a change still in development, edits that change's existing fragment, so a feature and its follow-up fixes stay one bullet. Never a section in `changelog.mdx`: a fragment is a file of its own, which is what stops every user-facing PR conflicting with every other one on rebase (#1386). See `@.claude/rules/changelog.md`.

### Post-merge worktree cleanup

After a PR is merged, the related worktree **must** be deleted:

```bash
git worktree remove ../ir-<issue>
```

Confirm deletion by verifying it no longer appears in `git worktree list`.

### Back-merging a release branch

A release branch (e.g. `release/1.21`) collects fixes through its own PRs, then is merged **back into `master`** so master picks them up. Unlike a feature PR, this is a **regular merge, never a squash** — squashing would flatten the release branch's whole history into one commit and re-introduce its entire diff, breaking the next sync. Do it locally or via a PR; either way keep full history:

```bash
git checkout master
git fetch origin
git merge origin/release/<x.y>     # regular merge; resolve conflicts (usually version strings only)
pnpm install && pnpm build && pnpm test   # verify the merge result before pushing
git push origin master
```

What to get right:

- **Version conflicts resolve in master's favour.** The release branch carries its release version (e.g. `1.21.0-rc.1`) while master is on the next dev version (e.g. `1.22.0-dev.0`), so every `package.json` / `manifest.json` conflict is version-only — keep master's. Strip the conflict markers **in place** (don't `git checkout --ours` the whole file) so any non-version content the release branch added stays merged.
- **Closing keywords must reach the default branch to auto-close issues.** A PR merged into `release/<x.y>` does **not** auto-close its `Fixes #N` issue — GitHub only honours closing keywords on merges into the **default branch** (`master`). So when back-merging, put `Closes #<issue>` (one per issue arriving on master through this merge) in the **merge commit message** (local merge) or the **PR body** (PR back-merge). Otherwise close those issues manually after pushing.
- **Fragment deletions arrive with the dated section.** The release branch's stable bump folded every fragment it held into `## <x.y.z>` and deleted them — its own fixes' and those inherited from `master` at the branch point, which did ship in that release — so the back-merge brings `master` the dated section plus those deletions. Fragments added on `master` after the branch point are not on the release side and survive as `master`'s next version (as `## Unreleased` while `master` still names the released version, #1398), and since `master`'s `changelog.mdx` does not change between releases the dated section lands cleanly. The one conflict is **modify/delete**: a fragment edited on `master` after the branch point and folded on the release branch. Resolve it by deleting the fragment (`git rm`), carrying the edit into the dated section if it matters — keeping it would ship the bullet twice. A cherry-picked fix leaves the same shape without a conflict, and the composer refuses a fragment whose bullet repeats a dated one, so the build names the fragment to delete.
- **Screenshot conflicts take one side whole.** In `packages/website/src/assets/settings-window/`, the side whose `capture.json` version is higher wins: take its whole folder, never mix files.
- **Do not delete the release branch on back-merge.** It stays alive to cut the actual release; the back-merge only forwards its commits to master.

### Releasing

The procedure lives in `README.md` under **Releasing** (release-it via `pnpm release`, the `v*` tag push that runs `release.yml`). Facts about it that are easy to get wrong:

- **A stable bump folds the changelog fragments** (#1386). The `before:bump` hook (`scripts/release-hooks.mjs`, `scripts/lib/changelog-fold.mjs`) composes every fragment in `changelog.d/` into a `## X.Y.Z` section of `changelog.mdx` dated today, deletes the fragments and stages both in the `chore(release)` commit. It validates everything before writing — a malformed or uncommitted fragment aborts the release with a clean tree — and `pnpm release:dry` prints the section it would write. A pre-release skips the fold, so an `-rc` build shows the fragments as the Unreleased release; a stable version with no fragments gets no section. Fragments merged before the next version bump compose as `## Unreleased` and fold into the next stable release (#1398).
- **A stable bump captures the Settings-window screenshots** (#1536): the `after:bump` hook (`scripts/release-capture.mjs`) builds the plugin and captures into the `chore(release)` commit. It needs a Chromium browser, the native toolchain and `IRACEDECK_DEV_VOICES` unset; see `website-screenshots.md`.
- **Voice-pack archives are published by the tag workflow, never by hand** (#1116). `scripts/publish-voice-packs.mjs` packs every published voice, verifies it against its committed `catalog/<id>.json`, and attaches it to its `voices-<id>-<version>` release with `--latest=false`. A mismatch fails the job before anything ships. Its `pack-records/<id>.json` (#1667, `audio-assets/CLAUDE.md`) makes a stale entry fail `pnpm test` first; the `before:bump` hook refuses a stale record with a clean tree, and on a version with no `dev` prerelease identifier seals every pack's version as released in the `chore(release)` commit, after the fold. A between-releases publish needs `pnpm seal:voice-packs <id>` committed to `master`; `--publish` refuses an unsealed pack. Run the *Publish voice packs* workflow with `publish` off as a dry run before tagging a release that changes a pack.
- **Closing the loop on the board (2026-09-05).** After the `v*` tag run has published a non-pre-release release, close that version's milestone and move every card of the milestone from `Testing` to `Done` on the Roadmap project (the lane meanings are in *Issue labels* above), with `setBoardStatus(<n>,'Done',process.cwd())`, which takes a card into `Done` from `Testing` only (#1574). Until this is automated in the release hooks it is a manual step of the release, done by whoever cuts it; a card left in `Testing` after its release is stale, not shipped-twice.
- **A voice pack shipped between releases never deploys `master`.** The same workflow with `publish` on builds the website from the latest stable plugin tag with only the catalog entries taken from `master`, at the commit the run packed and verified (`github.sha`, never the branch tip), and refuses the deploy if `master`'s catalog has moved since. A publish dispatched from any other ref fails before it packs; the dry run is open to any ref (#1392). The site ships from release tags only; documentation for unreleased work must not reach it early. Every website deploy, manual ones included, also refuses to build while any catalog entry names an archive that is not published yet — so after bumping a pack, publish it before deploying the site by hand.
- **A tagged `release/*` branch carries every live voice pack at or above its live version** (#1613) — in practice the pack commits published from `master` between releases. Every website deploy, as its last step before the Firebase deploy, compares its catalog with the live `https://iracedeck.com/voice-catalog.json` (semver) and refuses a live pack it names lower (always: a published version is bumped, never rolled back) or lacks while `master`'s catalog still has it, naming each with both versions; a live pack it lacks passes, with a warning, only as a withdrawal (`master`'s catalog lacks it and `master`'s history shows the entry was deleted there); one `master` never carried, shipped from an un-back-merged release branch, refuses; `master` is fetched (whole history, no file contents) only for that, refusing when unreadable. A pack not live never blocks, so an unpublished bump on `master` does not hold up a patch. A 404 passes with a warning; a network error, timeout, other status or non-catalog body refuses. Remedy: bring the pack from `master`, clips and catalog entry together (the tag's pack job repacks from the branch's clips), or withdraw it on `master` first (a pack `master` never had is back-merged onto `master` before either), then re-tag or re-run; on a between-releases publish (`master`'s catalog) back-merge the release's pack onto `master`, then dispatch again. The tag runs its own copy of `firebase-hosting-release.yml`, so a release branch cut before #1613 has no such check until it carries this change, and until then the rule is the releaser's alone.
