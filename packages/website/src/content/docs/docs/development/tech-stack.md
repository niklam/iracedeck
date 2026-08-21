---
title: Tech Stack
description: iRaceDeck's architecture, packages, and how it communicates with iRacing.
---

iRaceDeck is a monorepo built with [pnpm](https://pnpm.io/) workspaces. The codebase is organized into these packages:

:::tip[See also]
For a visual walkthrough of how these packages fit together and how data flows from iRacing to your deck, see [Architecture](/docs/development/architecture/).
:::

## Packages

| Package                                 | Description                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `@iracedeck/iracing-plugin-stream-deck` | The main Stream Deck plugin — all 31 actions, Property Inspector UI, and icon rendering |
| `@iracedeck/iracing-plugin-mirabox`     | The Mirabox plugin — the same actions for Mirabox / VSD Craft devices                   |
| `@iracedeck/iracing-plugin-ulanzi`      | The Ulanzi Deck plugin — the same actions for Ulanzi Deck devices                       |
| `@iracedeck/iracing-sdk`                | TypeScript SDK for reading iRacing telemetry and session data via shared memory         |
| `@iracedeck/iracing-native`             | Native C++ addon for Windows keyboard simulation and window management                  |
| `@iracedeck/icons`                      | SVG icon library for all Stream Deck button icons                                       |
| `@iracedeck/logger`                     | Shared logging library with scoped loggers                                              |
| `@iracedeck/website`                    | This documentation site (Astro + Starlight)                                             |

## How It Communicates with iRacing

The plugin communicates with iRacing through two channels:

### iRacing SDK (shared memory)

Used for telemetry data and SDK commands. This is the preferred method — it's reliable and doesn't depend on key bindings. Examples:

- Pit service commands (fuel, tires, fast repair)
- Chat macros and messages
- Replay transport and navigation
- Camera switching and focus
- Telemetry recording

### Keyboard simulation (native addon)

Used for actions that don't have SDK support. The native C++ addon sends scan codes directly to iRacing. Examples:

- Black box selection
- View and camera adjustments (FOV, horizon, driver height)
- Car setup adjustments (brake bias, traction control, etc.)
- Look direction (hold pattern)

All keyboard shortcuts are [user-configurable](/docs/features/key-bindings/) through the Property Inspector to match each user's iRacing key bindings.

## Build System

- **pnpm** for package management and workspaces
- **Rollup** for bundling the Stream Deck plugin
- **Vitest** for testing
- **Astro + Starlight** for the documentation website
- **[CodeRabbit](https://www.coderabbit.ai/)** for automated PR reviews

### Test configuration

The root `vitest.config.ts` is loaded with Vite's native config loader (`--configLoader native`, set on the `test` and `test:watch` scripts) instead of the default loader, which bundles the config with rolldown and runs the bundle. Vite has announced the native loader as a future default, so iRaceDeck opted in early — on its own schedule rather than on whichever dependency bump would otherwise have flipped it.

Node therefore imports that config directly and strips its types itself, so edits to `vitest.config.ts` have to stay within what Node can load:

- Use `import.meta.dirname` and `import.meta.filename`. The CommonJS `__dirname` and `__filename` globals are not declared in an ES module at all, so reading one throws a `ReferenceError`. They only ever resolved because the bundling loader substitutes them for the config's own directory and file.
- Mark type-only imports with `type`, as in `import { defineConfig, type Plugin } from "vitest/config"`. Node cannot tell which named imports are types, so an unmarked one becomes a value import of an export that does not exist and the config fails to load.
- Avoid TypeScript that needs more than type stripping: `enum`, `namespace`, decorators, and constructor parameter properties.

This applies only to the Vite/Vitest config file itself. Test files and package sources are transformed by Vite as usual and are unaffected.
