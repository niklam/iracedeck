# Contributing to iRaceDeck

Contributions are welcome. This guide is everything you need to go from an issue to a merged pull request; please read it before writing code. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems are reported privately, never in an issue: see [SECURITY.md](SECURITY.md).

## Start from an issue

Every pull request fixes one issue. Features, refactors and bug fixes all start there.

1. Check the [existing issues](https://github.com/niklam/iracedeck/issues) to see whether your bug or idea is already tracked.
2. If it is not, open one with the bug report or feature request template. A new feature is worth discussing in the issue before you build it: it is cheaper to hear that something does not fit before the code exists than after.
3. **Pick any issue that is not assigned to anyone.** Comment on it to say you are taking it, and it gets assigned to you. An issue that is already assigned is someone else's; choose another, or ask in its comments.

### What doesn't need an issue

- A typo fix in the documentation
- A fix for a broken link

Keep even these to small, focused pull requests.

## What we don't accept

- **Unsolicited refactors**: don't rewrite working code for style reasons.
- **Drive-by changes**: a pull request addresses its one issue. No unrelated cleanup, formatting or "while I was here" changes.
- **New dependencies** without a discussion in the issue first. Explain why it is needed and which alternatives you considered. Dependencies use exact versions (no `^` or `~`), and a version published less than a day ago does not resolve here.

## Development setup

**Prerequisites:**

- **Windows 10 or later** to run the plugin, since iRacing is Windows-only. You can also develop on macOS (or Linux): install, build and test all work there, with the native addons replaced by mocks. The plugin itself ships for Windows only.
- **Node.js 24.21.0**, the version pinned in [`.nvmrc`](.nvmrc) (`nvm` and `fnm` read it). Use nothing older than 24.16.0: Node 24.15.0 crashes test workers on Windows with exit code `3221226505`.
- **pnpm 12.6.0**, pinned in `packageManager` in `package.json`. Any pnpm 10 or later on your `PATH` switches itself to the pinned version.
- **Python 3 and [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload**, on Windows only, to build the two native addons (`iracing-native` and `audio-native`). On macOS the build skips them.
- **A deck host** to try your change on: the [Elgato Stream Deck](https://www.elgato.com/stream-deck) software 7.1 or later. HotSpot StreamDock or VSD Craft (Mirabox) and UlanziStudio (Ulanzi Deck) are only needed if you work on those plugins.

[Fork the repository](https://github.com/niklam/iracedeck/fork) first, then clone your fork, so `origin` is a remote you can push to, and add the main repository as `upstream` to fetch from:

```bash
git clone https://github.com/<your-user>/iracedeck.git
cd iracedeck
git remote add upstream https://github.com/niklam/iracedeck.git
pnpm install
pnpm build
```

Linking the built plugin to each deck host, watch mode, the per-developer `.env.local` and the other development commands are on the website's [Development Setup](https://iracedeck.com/docs/development/setup/) page.

## Making a change

1. Fetch `upstream` (`git fetch upstream`) and create a branch from `upstream/master`, named `<type>/<issue>-<short-description>`: `feature/123-fuel-calculator`, `fix/456-pit-limiter-flicker`. The types are `feature`, `fix`, `refactor`, `chore`, `hotfix` and `docs`.
2. Commit in logical steps with [Conventional Commits](https://www.conventionalcommits.org/), scoped to the package you changed: `feat(iracing-actions): add Fuel Calculator action`, `fix(iracing-sdk): handle disconnection`.
3. Add unit tests for new code. Tests use [Vitest](https://vitest.dev/) and sit beside their source (`foo.ts` → `foo.test.ts`). `pnpm test <path>` runs only the tests under a path, e.g. `pnpm test packages/iracing-sdk/`.
4. Follow the existing style. ESLint and Prettier are configured for the repository: run `pnpm lint:fix` and `pnpm format:fix`, and a pre-commit hook formats the files you commit. Neither tool touches Markdown, so never run Prettier on a `.md` file; keep each paragraph on one line, and give every fenced code block a language.

### Adding a new action

An action lives in its own folder, `packages/iracing-actions/src/actions/<action-name>/`, with its source, its tests, its Property Inspector template and its icons. It is registered once, in `packages/plugin-runtime/src/actions.ts`, which serves all three plugins, and declared in each plugin's `manifest.json` (Stream Deck, Mirabox and Ulanzi). Most actions also need key bindings, a comms catalog entry for each mode, a `docs-urls.json` entry and a page on the website.

The step-by-step walkthrough, with the reference action to copy, is [Adding a New Action](packages/iracing-plugin-stream-deck/CLAUDE.md#adding-a-new-action) in `packages/iracing-plugin-stream-deck/CLAUDE.md`.

## Checks before a pull request

Run all six and make sure each one passes:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm format
pnpm test
```

CI runs `typecheck`, `lint`, `format` and `test` as four separate jobs, so a clean `lint` says nothing about `format`. Read the build output rather than only its exit code.

## Changelog

A change that users can see or do something different with (an action, a mode, a setting, a Race Engineer callout, an icon, behaviour, the website) adds a **changelog fragment** in the same pull request: one small file in [`changelog.d/`](changelog.d/README.md), named `<issue>-<slug>.md`. Internal work with no visible effect, such as a refactor, tooling or a dependency bump, needs none, though a notable one may add a `Maintenance` fragment.

```markdown
---
category: Features
weight: 50
---

**Fuel Calculator** is a new action that shows how many laps your fuel will last.
```

- `category` is one of `Features`, `Improvements`, `Bug Fixes`, `Breaking changes` or `Maintenance`. `Bug Fixes` is only for something that shipped in an earlier release.
- `weight` is a whole number from 1 to 100: 50 is ordinary, higher for a headline change, lower for a minor one.
- The body is one line, written for users. Wrap a literal `<` or `{` in backticks.

If your change refines one that has not been released yet, edit that change's fragment instead of adding a second. The full format is in [`changelog.d/README.md`](changelog.d/README.md), and `pnpm generate:changelog-data` checks your fragment.

## Website documentation

If users can see your change, the website describes it, in the same pull request. Action pages live in `packages/website/src/content/docs/docs/actions/<category>/`; `tire-service.md` there is the model for a new one, and `.claude/rules/website-action-docs.md` describes the format.

## Pull requests

1. **Title it `<type>(<scope>): <description> (#<issue>)`**, for example `feat(iracing-actions): add Fuel Calculator action (#123)`. Pull requests are squash-merged, so the title becomes the commit on `master`, and its type (`feat`, `improve`, `fix`, `perf`, `refactor`, `docs`, `ci`, `chore`) decides where the change appears in the release notes.
2. **Fill in the pull request template**: the issue it fixes (`Fixes #123`), what changed, how to test it, and the checklist.
3. **Keep it focused**: one issue, one pull request.
4. **Answer the review.** [CodeRabbit](https://coderabbit.ai) reviews every pull request when it opens. Fix each finding that holds, and reply with your reasoning where one doesn't; after pushing a round of fixes, comment `@coderabbitai review` once to ask for another pass.
5. **Testing and merging are the maintainer's.** [@niklam](https://github.com/niklam) tests the change and merges it once the review is resolved and every check is green.

## Working with Claude Code

The repository carries its own [Claude Code](https://docs.claude.com/en/docs/claude-code) setup in `.claude/`: project instructions (`.claude/CLAUDE.md` and a `CLAUDE.md` in many packages), topic rules in `.claude/rules/`, skills, agents and hooks. Most of it helps you directly, since the rules load by themselves when you touch the files they cover. Some of it is the maintainer's own workflow, and you can ignore that part.

**Skills that help a contributor:**

- `iracedeck-actions`: every action, its modes and categories, and the action counts.
- `iracing-telemetry`: iRacing telemetry variable names, types and units.
- `cross-platform-development`: the native addons, their mocks and developing off Windows.
- `website`: the website's pages, content and conventions.

**The maintainer's workflow, which you can ignore:** every other skill in `.claude/skills/` (most plainly those whose description names Niklas, the PO or an issue lead), and the `architect`, `implementer`, `documenter` and `qa` agents. Likewise, the lines in `.claude/CLAUDE.md` about the agent team and `/po`, and the rules on specs, the project board, merging and releasing, describe how the maintainer runs the project, not what a contribution needs. In particular, you are never asked for a spec.

**The hooks run in your fork too.** `.claude/settings.json` registers hooks that check commands before they run. A refusal is a house rule, not a broken setup, and its message names the rule and what to do instead:

- `git worktree add` accepts only a sibling of your checkout named `ir-<issue>` (`../ir-123`), created from an up-to-date `origin/master`. In a fork `origin/master` is your fork's, which can lag the main repository, so bring it level with `upstream` first (`git fetch upstream`, `git push origin upstream/master:master`, then `git fetch origin`); the worktree then starts from the same code as a branch from `upstream/master`. A plain branch in your clone works just as well.
- Creating a worktree for an issue with no spec on `origin/master` asks before it goes ahead when the issue is an enhancement or its labels can't be read, which in a fork is usually every issue. That prompt is the maintainer's spec check; contributors don't write specs, so let it continue.
- `gh pr create` is refused unless the title has the form above.
- `/code-review` must name an effort level (`low`, `medium`, `high` or `xhigh`) and an `ir-<issue>` worktree to review, and never carries `--fix`.
- A subagent spawn must name its model, and may not ask for its own worktree.
- Shell-command guards refuse a set of known mistakes and give the correction: `pnpm exec vitest` (use `pnpm test <path>`), `pnpm build --force`, a piped `pnpm build` or `pnpm test` without `pipefail`, `jq`, `git diff master..<branch>`, `IRACEDECK_MOCK=0` and a few more. Linking, relinking or restarting a deck host asks first.

The hooks that move cards on the maintainer's project board and check merges act on `niklam/iracedeck` only, and need access a contributor doesn't have; a note from one that it could not do something is harmless.

## Contributor license

By submitting a contribution to this project, you agree that:

1. Your contribution is your own work, or you have the right to submit it.
2. You license your contribution under the project’s license.
3. You grant Niklas Lampén a perpetual, worldwide, non-exclusive, royalty-free license to use, modify, and sublicense your contribution, including as part of commercial and proprietary versions of iRaceDeck. This means your contribution may be used in both non-commercial and commercial versions of the Software.

This allows iRaceDeck to evolve, including commercial versions, while keeping the core project free and available to the community.

## Questions?

Join the [iRaceDeck Discord](https://discord.gg/c6nRYywpah) or comment on an issue. Don't open a pull request to ask a question.
