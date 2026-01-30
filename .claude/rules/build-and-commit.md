---
# Build & Commit Conventions

Build

- Install and build with pnpm: `pnpm install` then `pnpm build` (or package-specific build scripts).
- Useful shortcuts:

```bash
pnpm build:stream-deck
pnpm watch:stream-deck
```

Branching

New features and changes must be developed in a new branch, not directly on `master`.

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

Merging

- PRs are squash-merged into `master` via `gh pr merge --squash`.
- The squash commit subject is the PR title, which must follow conventional commit format (`<type>(<scope>): <description>`).
- Ensure the PR title is a valid conventional commit message before merging.
- Merging is performed manually or by automation — never by a Claude review step.
