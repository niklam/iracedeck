---
title: Tech Stack
description: iRaceDeck's architecture, packages, and how it communicates with iRacing.
---

iRaceDeck is a monorepo built with [pnpm](https://pnpm.io/) workspaces. The codebase is organized into these packages:

## Packages

| Package | Description |
|---------|-------------|
| `@iracedeck/stream-deck-plugin` | The main Stream Deck plugin — all 30 actions, Property Inspector UI, and icon rendering |
| `@iracedeck/iracing-sdk` | TypeScript SDK for reading iRacing telemetry and session data via shared memory |
| `@iracedeck/iracing-native` | Native C++ addon for Windows keyboard simulation and window management |
| `@iracedeck/icons` | SVG icon library for all Stream Deck button icons |
| `@iracedeck/logger` | Shared logging library with scoped loggers |
| `@iracedeck/website` | This documentation site (Astro + Starlight) |

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
