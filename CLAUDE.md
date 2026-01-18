# iRaceDeck

Stream Deck plugins for iRacing. Monorepo with pnpm workspaces + Turbo.

## Packages

- `@iracedeck/logger` - Logger interface with LogLevel enum
- `@iracedeck/iracing-native` - Native C++ addon (node-addon-api) for iRacing SDK
- `@iracedeck/iracing-sdk` - High-level wrapper: IRacingSDK, SDKController, commands, types
- `@iracedeck/stream-deck-shared` - Shared utilities for Stream Deck plugins (logger adapter)
- `@iracedeck/stream-deck-plugin` - Main plugin (`.sdPlugin` folder: `com.iracedeck.sd.sdPlugin`)
- `@iracedeck/stream-deck-plugin-comms` - Communication plugin (`.sdPlugin` folder: `com.iracedeck.sd.comms.sdPlugin`)
- `@iracedeck/stream-deck-plugin-pit` - Pit service plugin (`.sdPlugin` folder: `com.iracedeck.sd.pit.sdPlugin`)
- `@iracedeck/website` - Promotional website hosted on Firebase

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

## Making changes

- All changes must be tracked in git. For example moving files must be trackable, not just delete old file & create new file.

## Stream Deck Plugins

- Stream Deck Actions are located in {package}/src/actions/\*\*
- All actions must extend class ConnectionStateAwareAction from packages\stream-deck-shared\src\connection-state-aware-action.ts
- All action settings must be using Zod if action has settings
- Actions must not handle offline state (no data available) themselves. This is handled globally.

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
- Any `<text class="title">` will be removed from SVG when no data is available
- If property `data-no-na="true"` is added to `<svg>`, "N/A" will not be displayed when data is not active

The `<g>` tag with the filter is very important as that controls the activity state.

### Icon Templates

Icon templates are SVG files with Mustache-style `{{placeholder}}` syntax for dynamic values. Templates are:

- Located in `{package}/icons/` folder (e.g., `packages/stream-deck-plugin-pit/icons/do-fuel-add.svg`)
- Imported as strings at build time via rollup svgPlugin
- Rendered using `renderIconTemplate(template, { placeholder: "value" })`
- Converted to data URIs with `svgToDataUri(svg)`

Example template (`icons/do-fuel-add.svg`):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" data-no-na="true">
  <g filter="url(#activity-state)">
    <!-- icon graphics -->
    <text x="36" y="65">{{amount}}</text>
  </g>
</svg>
```

Example usage in action:
```typescript
import { renderIconTemplate, svgToDataUri } from "@iracedeck/stream-deck-shared";
import doFuelAddTemplate from "../../icons/do-fuel-add.svg";

const svg = renderIconTemplate(doFuelAddTemplate, { amount: "+5 L" });
const dataUri = svgToDataUri(svg);
```

Use `escapeXml()` from `@iracedeck/stream-deck-shared` for user-provided text values.

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
