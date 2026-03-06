# Contributing to iRaceDeck

Contributions are welcome — but to keep things manageable, all contributions go through a structured process. Please read this before writing any code.

## Golden Rule: Issues First

**Do not open a pull request without an approved issue.** This applies to features, refactors, and non-trivial bug fixes.

1. Check [existing issues](https://github.com/niklam/iracedeck/issues) to see if your idea or bug is already tracked.
2. If not, open a new issue using the appropriate template (bug report or feature request).
3. Wait for the issue to be approved (labeled `approved` or `help wanted`) before starting work.

This prevents wasted effort on both sides. If an issue isn't approved, a PR for it will be closed.

### What doesn't need an issue

- Typo fixes in documentation
- Fixing a broken link

Even these should be small, focused PRs.

## What We Don't Accept

- **Unsolicited refactors** — don't rewrite working code for style reasons.
- **Drive-by changes** — PRs must address one approved issue. No unrelated cleanup, formatting, or "while I was here" changes.
- **New dependencies** without prior discussion in the issue. Explain why it's needed and what alternatives you considered.

## Development Setup

**Prerequisites:**

- Windows 10+ (iRacing is Windows-only)
- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 10+
- Python 3.x and [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload (for the native addon)
- [Elgato Stream Deck](https://docs.elgato.com/sdk/) software

```bash
git clone https://github.com/niklam/iracedeck.git
cd iracedeck
pnpm install
pnpm build
```

## Pull Request Process

1. Fork the repo and create a branch from `master`: `feature/123-short-description` (reference the issue number).
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) with package scope, e.g. `feat(stream-deck-plugin): add new action`.
3. Add tests for new code (Vitest).
4. Make sure `pnpm build` and `pnpm test` pass.
5. Open a pull request and link the approved issue.
6. Keep the PR focused — one issue, one PR.

All PRs require review and approval from [@niklam](https://github.com/niklam) before merging.

## Code Style

This project uses ESLint and Prettier. Run `pnpm lint:fix` and `pnpm format:fix` before committing. Don't include formatting-only changes in feature PRs.

## Adding a New Action

Actions live in `packages/stream-deck-plugin/src/actions/`. Each action needs:

1. An action class extending `ConnectionStateAwareAction`
2. Registration in `plugin.ts`
3. An entry in `manifest.json`
4. Category icon (20x20 SVG) and key icon (72x72 SVG)
5. A Property Inspector template (EJS → HTML)
6. Unit tests

Use existing actions as reference, or check the package-level docs in `packages/stream-deck-plugin/`.

## License

By submitting a pull request, you agree that your contribution will be licensed under the [MIT License](LICENSE.md) that covers this project.

## Questions?

Join the [iRaceDeck Discord](https://discord.gg/c6nRYywpah) or comment on an issue. Don't open a PR to ask a question.
