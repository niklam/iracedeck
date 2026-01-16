# iRaceDeck

Stream Deck plugins for iRacing. Monorepo with pnpm workspaces + Turbo.

## Packages

- `@iracedeck/logger` - Logger interface with LogLevel enum
- `@iracedeck/iracing-native` - Native C++ addon (node-addon-api) for iRacing SDK
- `@iracedeck/iracing-sdk` - High-level wrapper: IRacingSDK, SDKController, commands, types
- `@iracedeck/stream-deck-shared` - Shared utilities for Stream Deck plugins (logger adapter)
- `@iracedeck/stream-deck-plugin` - Main plugin (`.sdPlugin` folder: `fi.lampen.niklas.iracedeck.sdPlugin`)
- `@iracedeck/stream-deck-plugin-comms` - Communication plugin (`.sdPlugin` folder: `fi.lampen.niklas.iracedeck.comms.sdPlugin`)

## Architecture

### Legacy (being refactored)

- SDK classes use singletons with `getInstance()` - moving to dependency injection
- `IRacingSDK.setLoggers(logger)` configures logging for all SDK singletons

### Design Principles

- Follow SOLID principles
- Inject dependencies, no hardcoded singletons in business logic
- Use interfaces for external dependencies (prefix with `I`: `IConnectionManager`)
- Use `type` for data shapes: `TelemetryData`, `SessionInfo`
- No side effects in constructors or class methods (return new state, don't mutate)
- All new code must have unit tests (test file: `foo.ts` → `foo.test.ts`)
- Test framework: Vitest (ESM-native, `describe`/`it`/`expect` API)

## Stream Deck Plugins

- All actions must extend class ConnectionStateAwareAction from packages\stream-deck-shared\src\connection-state-aware-action.ts
- All action settings must be using Zod

## Icons

- Key Icon is an icon that is displayed in Stream Deck
- These icons must always be of type SVG
- The SVG must follow this format:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    {The actual content here}
  </g>
</svg>
```

- The text size should be between 12 and 25 pixels
- The text y-position below the graphic must be y="65"

The <g> tag with the filter is very important as that controls the activity state.

## Conventions

- Run `pnpm lint:fix` and `pnpm format:fix` before committing
- Use Zod with `z.coerce` for action settings (Stream Deck sends strings)
- Flag utilities: `hasFlag()`, `addFlag()`, `removeFlag()` from types.ts

## Build

```bash
pnpm install
pnpm build                    # Build all
pnpm build:stream-deck        # Build Stream Deck plugins only
pnpm watch:stream-deck        # Watch mode for Stream Deck plugins
pnpm lint:fix                 # Fix linting issues
pnpm format:fix               # Fix formatting issues
pnpm test                     # Run tests once
pnpm test:watch               # Run tests in watch mode
```

## Commiting code

- Use conventional commits
- The scope in conventional commit should usually be the package
- Do not add any references to Claude or any other AI tool to commit messages
- Do not add co-authors such as "Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>" to commit messages

## References

- iRacing SDK: https://forums.iracing.com/discussion/15068/official-iracing-sdk
- Stream Deck SDK: https://docs.elgato.com/sdk/
