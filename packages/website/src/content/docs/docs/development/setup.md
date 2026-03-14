---
title: Setup
description: How to clone, build, and run iRaceDeck locally for development.
---

## Prerequisites

- **Node.js** 24 or newer
- **pnpm** (install with `npm install -g pnpm`)
- **Windows** (required for the native addon and iRacing integration)
- **Stream Deck software** 7.1 or newer

## Getting Started

```bash
# Clone the repository
git clone https://github.com/niklam/iracedeck.git
cd iracedeck

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Link the plugin to Stream Deck for testing
pnpm link:stream-deck

# Start watching for changes (auto-rebuilds on save)
pnpm watch:stream-deck
```

After linking, restart the Stream Deck software. The plugin will appear in the action list as **iRaceDeck**. Changes you make will be picked up automatically when using `watch:stream-deck`.

## Useful Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm build:stream-deck` | Build only the Stream Deck plugin |
| `pnpm watch:stream-deck` | Watch mode — rebuild on file changes |
| `pnpm link:stream-deck` | Register the plugin with Stream Deck |
| `pnpm unlink:stream-deck` | Unregister the plugin |
| `pnpm relink:stream-deck` | Unlink + link (useful when switching branches) |
| `pnpm test` | Run all tests |
