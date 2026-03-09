# GitHub Actions CI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add CI checks (tests, lint, format) that run on every pull request including drafts.

**Architecture:** Three separate GitHub Actions workflow files, each producing an independent status check. All run on `ubuntu-latest` since tests mock native dependencies.

**Tech Stack:** GitHub Actions, pnpm, vitest, eslint, prettier

---

## Design Decisions

- Three separate workflow files (not one workflow with jobs) — independent status checks, easier to maintain
- `ubuntu-latest` for all — native deps are mocked in tests, `keysender` skipped via `onlyBuiltDependencies`
- `pull_request` trigger — fires on opened (including drafts), synchronize, reopened
- No push-to-master trigger — PR-only since we squash-merge

---

### Task 1: Create branch

**Step 1: Create feature branch**

```bash
git checkout -b chore/github-actions-ci
```

---

### Task 2: Create ci-test.yml

**Files:**
- Create: `.github/workflows/ci-test.yml`

**Step 1: Write the workflow file**

```yaml
name: Tests

on:
  pull_request:

jobs:
  test:
    name: Run tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.node-version'
          cache: 'pnpm'

      - run: pnpm install

      - run: pnpm test
```

**Step 2: Commit**

```bash
git add .github/workflows/ci-test.yml
git commit -m "ci: add test workflow for pull requests"
```

---

### Task 3: Create ci-lint.yml

**Files:**
- Create: `.github/workflows/ci-lint.yml`

**Step 1: Write the workflow file**

```yaml
name: Lint

on:
  pull_request:

jobs:
  lint:
    name: ESLint check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.node-version'
          cache: 'pnpm'

      - run: pnpm install

      - run: pnpm lint
```

**Step 2: Commit**

```bash
git add .github/workflows/ci-lint.yml
git commit -m "ci: add lint workflow for pull requests"
```

---

### Task 4: Create ci-format.yml

**Files:**
- Create: `.github/workflows/ci-format.yml`

**Step 1: Write the workflow file**

```yaml
name: Format

on:
  pull_request:

jobs:
  format:
    name: Prettier check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.node-version'
          cache: 'pnpm'

      - run: pnpm install

      - run: pnpm format
```

**Step 2: Commit**

```bash
git add .github/workflows/ci-format.yml
git commit -m "ci: add format workflow for pull requests"
```

---

### Task 5: Push and create PR

**Step 1: Push the branch**

```bash
git push -u origin chore/github-actions-ci
```

**Step 2: Create the PR**

```bash
gh pr create --title "ci: add GitHub Actions CI checks for pull requests" --body "..."
```

The PR itself will trigger all three workflows, serving as a live test.
