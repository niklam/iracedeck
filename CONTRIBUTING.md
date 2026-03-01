# Contributing to iRaceDeck

Thank you for your interest in contributing to iRaceDeck! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 10+
- Windows (required for iRacing SDK)
- Stream Deck hardware and software (for plugin development)

### Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build the project:
   ```bash
   pnpm build
   ```

## Development Workflow

### Building

```bash
pnpm build                    # Build all packages
pnpm build:stream-deck        # Build Stream Deck plugins only
pnpm watch:stream-deck        # Watch mode for Stream Deck plugins
```

### Testing

```bash
pnpm test                     # Run tests once
pnpm test:watch               # Run tests in watch mode
```

### Linting and Formatting

Always run these before committing:

```bash
pnpm lint:fix                 # Fix linting issues
pnpm format:fix               # Fix formatting issues
```

Or run the full precommit check:

```bash
pnpm precommit
```

## Code Guidelines

### Design Principles

- Follow SOLID principles
- Use dependency injection instead of hardcoded singletons
- Use interfaces for external dependencies (prefix with `I`: `IConnectionManager`)
- Use `type` for data shapes: `TelemetryData`, `SessionInfo`
- No side effects in constructors or class methods (return new state, don't mutate)

### Testing

- All new code must have unit tests
- Test file naming: `foo.ts` → `foo.test.ts`
- Test framework: Vitest with `describe`/`it`/`expect` API

### Stream Deck Actions

- Actions are located in `{package}/src/actions/**`
- All actions must extend `ConnectionStateAwareAction` from `src/shared/` in the core plugin
- Use Zod with `z.coerce` for action settings (Stream Deck sends strings)
- Actions must not handle offline state themselves - this is handled globally

### Icons

- Key icons must be SVG format with 72x72 viewBox
- Use the required SVG structure with `<g filter="url(#activity-state)">`
- Text size: 12-25 pixels
- Text y-position below graphics: `y="65"`
- See `CLAUDE.md` for detailed icon template documentation

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Scope

The scope should usually be the package name:

- `logger`
- `iracing-native`
- `iracing-sdk`
- `stream-deck-plugin-core`
- `website`

### Examples

```
feat(stream-deck-plugin-core): add fuel calculation action
fix(iracing-sdk): handle disconnection gracefully
refactor(iracing-sdk): simplify telemetry parsing
```

## Pull Requests

1. Create a feature branch from `master`
2. Make your changes following the guidelines above
3. Ensure all tests pass: `pnpm test`
4. Run linting and formatting: `pnpm lint:fix && pnpm format:fix`
5. Commit with conventional commit messages
6. Push and open a pull request

## Project Structure

```
packages/
├── logger/                    # Logger interface
├── iracing-native/            # Native C++ addon for iRacing SDK
├── iracing-sdk/               # High-level SDK wrapper
├── stream-deck-plugin-core/   # Stream Deck plugin (actions, shared utilities, PI components)
└── website/                   # Promotional website
```

## Resources

- [iRacing SDK Documentation](https://forums.iracing.com/discussion/15068/official-iracing-sdk)
- [Stream Deck SDK Documentation](https://docs.elgato.com/sdk/)

## Questions?

If you have questions or need help, feel free to open an issue for discussion.
