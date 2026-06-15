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

**Always review the full build output.** The build may succeed (exit code 0) while still emitting TypeScript warnings from `@rollup/plugin-typescript`. These warnings indicate real type errors that must be fixed before committing.

- Run the build and capture all output (do not just check the exit code or tail the last few lines).
- Search the output for `TS[0-9]+:` patterns (e.g., `TS2345`, `TS2322`) — these are TypeScript diagnostics that need fixing.
- Ignore `Circular dependency` warnings from `zod` internals and `npm warn Unknown env config` — these are known and harmless.
- Common cause: `vi.fn(() => null)` in test files infers return type as `null`, making `mockReturnValue({...})` a type error. Fix by widening the return type: `vi.fn((): Record<string, unknown> | null => null)`.

Branching & Worktrees

**IMPORTANT — before writing any code, ask the user:**

> Where should this work happen: worktree, branch, or master?

- **Worktree** (default for issues/features) — isolated sibling directory, ends with a PR.
- **Branch** — branch in the current working tree, ends with a PR.
- **Master** — direct work on master, pushed without a PR.

Do not assume. Do not start coding until the user answers.

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

Do not commit if either step fails. Fix the issue first.

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

  If yes, run it (via the `code-review` skill or `code-reviewer` agent) and address any issues found before opening the PR.

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

When creating issues, always include requirements for updating all affected artifacts beyond the code itself. If the change affects actions, features, or behavior described in any of these, the issue must list them:

- **All plugin packages** — registration in `plugin.ts`, manifest entries, and PI templates for every applicable plugin (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`)
- **Website** (`@iracedeck/website`) — action descriptions, feature lists, action counts, and the changelog page (`changelog.mdx`) for any user-facing change — see `@.claude/rules/changelog.md`
- **Action documentation** (`docs/`) — action docs, keyboard shortcut tables
- **Skills** (`iracedeck-actions`, `iracing-telemetry`, etc.) — action/mode/sub-action listings
- **Rules and guidance** (`.claude/rules/`, `CLAUDE.md` files) — conventions, patterns, references

Merging

- Feature/fix PRs are **squash-merged** into their target branch via `gh pr merge --squash` — one commit per PR. This is the default for `master` and every other branch (`release/*` / integration branches included). The PR **title** becomes the squashed commit's message, so title discipline matters doubly (see the title rules below).
- **Branch-to-branch merges are NOT squashed.** Release-branch back-merges and the periodic `master` ↔ `release/*` syncs use a regular merge (`gh pr merge --merge`, or a local `git merge`) — squashing one would collapse the other branch's whole history into a single commit and re-introduce its entire diff, causing avoidable conflicts on the next sync. See **Back-merging a release branch** below.
- **`release/2.0` integration branch (temporary).** The dials/touchscreen clean-slate (#640) and the follow-up dial-rebuild issues are breaking changes that ship as v2.0.0, so their PRs target `release/2.0` (`gh pr create --base release/2.0`), not `master` — squash-merged like any feature PR. Master keeps shipping 1.x releases; sync `master` into `release/2.0` periodically (a regular merge — see **Back-merging a release branch**) to limit drift, and avoid cherry-picking between the two lines (land shared fixes on `master` and sync them in). When 2.0 ships (`pnpm release major` from `release/2.0`), the branch merges back into `master` and this note is removed.
- **PR titles must include the issue number** at the end in parentheses: `<type>(<scope>): <description> (#<issue>)`. Example: `feat(actions): add Camera Focus action (#42)`. Under squash-merge this title is the commit message that lands on the branch, so it must read as a complete commit subject.
- **PR titles drive release notes.** The conventional commit prefix determines the release notes category via auto-labeling (see **PR Labels** above). Use the correct prefix so the change appears in the right section.
- Merging is performed manually or by automation — never by a Claude review step.
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
