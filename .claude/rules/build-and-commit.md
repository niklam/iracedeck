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

All development must happen in a **git worktree**, never directly in the main working tree on `master`. Worktrees are created as sibling directories of the main working tree (same parent directory), named `ir-<issue>`.

### Worktree workflow

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

Split work into logical, self-contained commits. Each commit should represent one coherent change that builds and passes tests on its own. This keeps the history readable and makes regular (non-squash) merges practical.

Guidelines:

- **One concern per commit** — don't mix a refactor with a new feature or unrelated fixes.
- **Commit as you go** — commit each logical step when it's complete, don't batch everything into one giant commit at the end.
- **Commit message = what and why** — the diff shows _what_ changed; the message should explain _why_.

Examples of good commit splits for a new action:

```
feat(actions): add FuelCalculator action and icons
feat(stream-deck-plugin): register FuelCalculator action and PI
feat(mirabox-plugin): register FuelCalculator action
test(actions): add FuelCalculator unit tests
docs: add FuelCalculator action documentation
```

Pull Requests

- When creating a PR, use the PR template at `.github/pull_request_template.md` as the body structure.
- Fill in all sections: Related Issue, What changed?, How to test, and Checklist.
- Mark checklist items as complete (`[x]`) or incomplete (`[ ]`) as appropriate.
- Use `N/A` for sections that don't apply (e.g., "Related Issue" for infra work with no issue).
- Build, test, and lint checks are handled by CI — they are not in the PR checklist.
- **Before creating a PR**, run the code-review agent (via the `code-review` skill or `code-reviewer` agent) to review all changes on the branch. Address any issues found before opening the PR.

Issues

When creating issues, always include requirements for updating all affected artifacts beyond the code itself. If the change affects actions, features, or behavior described in any of these, the issue must list them:

- **All plugin packages** — registration in `plugin.ts`, manifest entries, and PI templates for every applicable plugin (`stream-deck-plugin`, `mirabox-plugin`)
- **Website** (`@iracedeck/website`) — action descriptions, feature lists, action counts
- **Action documentation** (`docs/`) — action docs, keyboard shortcut tables
- **Skills** (`iracedeck-actions`, `iracing-telemetry`, etc.) — action/mode/sub-action listings
- **Rules and guidance** (`.claude/rules/`, `CLAUDE.md` files) — conventions, patterns, references

Merging

- PRs are merged into `master` via `gh pr merge --merge` (regular merge, not squash).
- Since commits are logical and self-contained, squashing is not needed — the full commit history is preserved on `master`.
- **PR titles must include the PR number** at the end in parentheses: `<type>(<scope>): <description> (#<PR>)`. Example: `feat(actions): add Camera Focus action (#42)`.
- Merging is performed manually or by automation — never by a Claude review step.

### Post-merge worktree cleanup

After a PR is merged, the related worktree **must** be deleted:

```bash
git worktree remove ../ir-<issue>
```

Confirm deletion by verifying it no longer appears in `git worktree list`.
