---

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

### Build verification

**Always review the full build output.** Since #987 all four rollup configs set `noEmitOnError`, so a TypeScript diagnostic in a rollup-built package is a hard build failure rather than a warning on a green build — that is what the flag is for. Reading the output still matters, because a build can fail or misbehave for reasons that are not type errors.

- Run the build and capture all output (do not just check the exit code or tail the last few lines).
- Search the output for `TS[0-9]+:` patterns (e.g., `TS2345`, `TS2322`). Before #987 these could appear as *warnings* on a build that exited 0 and shipped broken output; they are now fatal, so finding one means the build failed.
- Ignore `Circular dependency` warnings from `zod` internals and `npm warn Unknown env config` — these are known and harmless.
- Common cause: `vi.fn(() => null)` in test files infers return type as `null`, making `mockReturnValue({...})` a type error. Fix by widening the return type: `vi.fn((): Record<string, unknown> | null => null)`.

Branching & Worktrees

**IMPORTANT — before writing any code, ask the user:**

> Where should this work happen: worktree, branch, or master?

- **Worktree** (default for issues/features) — isolated sibling directory, ends with a PR.
- **Branch** — branch in the current working tree, ends with a PR.
- **Master** — direct work on master, pushed without a PR.

Do not assume. Do not start coding until the user answers.

**Exception — issue work is already settled (#1044).** An issue is solved in a worktree; don't re-ask per issue. The question above governs work that is *not* an issue, and the maintainer can still direct otherwise at any time. See `@.claude/rules/issue-workflow.md` for the full pipeline.

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

**Why typecheck is separate from build.** Until #987 a green `pnpm build` said nothing about the type correctness of the rollup-built packages: `@rollup/plugin-typescript` reports type errors as rollup *warnings* and emits anyway unless `noEmitOnError` is set, so a build could report success while shipping a bundle that throws at startup. All four rollup configs — the three plugins and `pi-components` — now set `noEmitOnError`, which closes that at authoring time. `pnpm typecheck` is the explicit gate and is what a red CI run reproduces; see `@.claude/rules/testing.md` for what it does and does not cover.

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
- **Before creating a PR, ask the user:**
  > Should we run the code review agent for these changes?

  Name the effort level in the ask and say which row of the table in `@.claude/rules/code-review.md` the change landed in — `xhigh` is not the default. If yes, run it (via the `code-review` skill or `code-reviewer` agent) at that level, pointed at the worktree that holds the work rather than `master`. The review reports only — never `--fix`; verify each finding and apply the ones that hold as your own edits before opening the PR.

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

Issues

Issue templates automatically apply labels (`bug`, `enhancement`). These are separate from the `type:` labels used on PRs for release notes categorization — do not manually add `type:` labels to issues.

### Issue labels: kind and area; priority on the board (2026-09-05)

Two more axes sit beside `bug` / `enhancement`, one value each, so the backlog can be sorted by what the work is and where it lands; how much it matters lives on the board (below), not in a label. `bug` / `enhancement` keep saying "user-facing fix" / "user-facing feature"; the `kind:` axis names the work that is NOT user-facing.

| Axis | Values | Who sets it |
|------|--------|-------------|
| `kind:` | `kind: hygiene` (housekeeping, no user-visible change: lint gaps, duplication, stale docs, renames), `kind: dev-experience` (harness, build, CI, rules, tooling for whoever works on the repo), `kind: research` (a spike ending in a decision, not a PR); omitted for user-facing work | The filer, at filing |
| `area:` | `area: race-engineer` (Race Engineer, radar, spotter, voice packs, callouts, audio), `area: actions` (actions, dials, key icons, profiles), `area: settings` (settings window, Property Inspectors, global settings, first run), `area: website`, `area: platform` (deck-core, adapters, plugins, native addons, build and release tooling, CI, process) — the area the WORK lands in, not the one mentioned | The filer, at filing |

Milestones keep saying *when*. `discord` (a mirrored Discord request), `breaking change`, `documentation` and `wontfix` are unchanged and orthogonal. The backfill over every issue, open and closed, was done on 2026-09-05; a new issue gets its `kind:` (when it has one) and `area:` at filing. Priority labels (`p1`–`p3`) existed for a few hours that day and were retired in favour of the board's lanes.

**The board.** The *iRaceDeck Roadmap* project (`https://github.com/users/niklam/projects/1`, `gh project … 1 --owner niklam`) is a view over the same issues, never a second record, and it is where priority lives. Its `Status` lanes are `Backlog` (fine to sit), `Planned` (this or next release), `Next` (the agreed order, top first), `In progress` (a worktree exists — through the manual test, the PR and the merge), `Testing` (merged to `master` but not yet in a stable release: the milestone is still open), `Done` (shipped: a non-pre-release release carrying it is published and its milestone closed) and `Dropped` (closed as not planned or duplicate). Every closed issue is on it too, with `area:` and `kind:` but no priority, so the board is the history as well as the plan. An agent adds a new issue to the board at filing (`gh project item-add 1 --owner niklam --url <issue url>`) into `Backlog`, proposes a lane in conversation when it has an opinion, and never moves a card into `Next` or `Planned` itself — that is Niklas's call; it moves the card to `In progress` when the worktree is created. The project's own workflow moves a card to `Testing` when the pull request that closes it is merged (added 2026-09-05), so a merge needs no hand. An issue closed WITHOUT a merged PR does not move at all: whoever closes it moves the card — to `Dropped` for not planned or duplicate, to `Testing` in the rare case something shipped through a commit rather than a PR. **`Done` is a release step, not a merge step:** cutting a stable release closes its milestone and moves every card of that milestone from `Testing` to `Done` — see *Releasing* below. Lanes need the `project` token scope (`gh auth refresh -s project,read:project`). Never rewrite the `Status` field's option list through the API: `updateProjectV2Field` replaces the options and regenerates their ids, which clears every card's lane — add a lane in the UI instead.

When creating issues, always include requirements for updating all affected artifacts beyond the code itself. If the change affects actions, features, or behavior described in any of these, the issue must list them:

- **All plugin packages** — registration in `plugin.ts`, manifest entries, and PI templates for every applicable plugin (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`)
- **Website** (`@iracedeck/website`) — action descriptions, feature lists, action counts, and the changelog page (`changelog.mdx`) for any user-facing change — see `@.claude/rules/changelog.md`; and the developer **Architecture page** (`docs/development/architecture.md`) when the change touches package structure, the abstraction seams, data flow, or the dependency graph
- **Action documentation** (`docs/`) — action docs, keyboard shortcut tables
- **Skills** (`iracedeck-actions`, `iracing-telemetry`, etc.) — action/mode/sub-action listings
- **Rules and guidance** (`.claude/rules/`, `CLAUDE.md` files) — conventions, patterns, references

Merging

- Feature/fix PRs are **squash-merged** into their target branch via `gh pr merge --squash` — one commit per PR. This is the default for `master` and every other branch (`release/*` / integration branches included). The PR **title** becomes the squashed commit's message, so title discipline matters doubly (see the title rules below).
- **Branch-to-branch merges are NOT squashed.** Release-branch back-merges and the periodic `master` ↔ `release/*` syncs use a regular merge (`gh pr merge --merge`, or a local `git merge`) — squashing one would collapse the other branch's whole history into a single commit and re-introduce its entire diff, causing avoidable conflicts on the next sync. See **Back-merging a release branch** below.
- **PR titles must include the issue number** at the end in parentheses: `<type>(<scope>): <description> (#<issue>)`. Example: `feat(actions): add Camera Focus action (#42)`. Under squash-merge this title is the commit message that lands on the branch, so it must read as a complete commit subject.
- **PR titles drive release notes.** The conventional commit prefix determines the release notes category via auto-labeling (see **PR Labels** above). Use the correct prefix so the change appears in the right section.
- Merging is performed manually or by automation, or by the agent driving the work once CodeRabbit has approved and checks are green (#1044) — but **never by a Claude review step**. Reviewing and merging stay separate hands.
- **Update the changelog.** Any user-facing change merging to `master` or a `release/*` branch must update the changelog page (`packages/website/src/content/docs/changelog.mdx`) in the same PR, collapsing a feature and its follow-up fixes into a single line. See `@.claude/rules/changelog.md`.

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

Three things to get right:

- **Version conflicts resolve in master's favour.** The release branch carries its release version (e.g. `1.21.0-rc.1`) while master is on the next dev version (e.g. `1.22.0-dev.0`), so every `package.json` / `manifest.json` conflict is version-only — keep master's. Strip the conflict markers **in place** (don't `git checkout --ours` the whole file) so any non-version content the release branch added stays merged.
- **Closing keywords must reach the default branch to auto-close issues.** A PR merged into `release/<x.y>` does **not** auto-close its `Fixes #N` issue — GitHub only honours closing keywords on merges into the **default branch** (`master`). So when back-merging, put `Closes #<issue>` (one per issue arriving on master through this merge) in the **merge commit message** (local merge) or the **PR body** (PR back-merge). Otherwise close those issues manually after pushing.
- **Do not delete the release branch on back-merge.** It stays alive to cut the actual release; the back-merge only forwards its commits to master.

### Releasing

The procedure lives in `README.md` under **Releasing** (release-it via `pnpm release`, the `v*` tag push that runs `release.yml`). Two facts about it that are easy to get wrong:

- **Voice-pack archives are published by the tag workflow, never by hand** (#1116). `scripts/publish-voice-packs.mjs` packs every published voice, verifies it against the committed `packages/audio-assets/catalog/<id>.json`, and attaches it to its `voices-<id>-<version>` release with `--latest=false`. A mismatch fails the job before anything ships; the fix is a `version` bump plus a regenerated entry, committed. Run the *Publish voice packs* workflow with `publish` off as a dry run before tagging a release that changes a pack.
- **Closing the loop on the board (2026-09-05).** After the `v*` tag run has published a non-pre-release release, close that version's milestone and move every card of the milestone from `Testing` to `Done` on the Roadmap project (the lane meanings are in *Issue labels* above). Until this is automated in the release hooks it is a manual step of the release, done by whoever cuts it; a card left in `Testing` after its release is stale, not shipped-twice.
- **A voice pack shipped between releases never deploys `master`.** The same workflow with `publish` on builds the website from the latest stable plugin tag with only the catalog entries taken from the dispatched branch. The site ships from release tags only; documentation for unreleased work must not reach it early. Every website deploy, manual ones included, also refuses to build while any catalog entry names an archive that is not published yet — so after bumping a pack, publish it before deploying the site by hand.
