---
title: Setup
description: How to clone, build, and run iRaceDeck locally for development.
---

## Prerequisites

- **Node.js** 24 or newer
- **pnpm** (install with `npm install -g pnpm`)
- **Windows** (required for the native addon and iRacing integration)
- **Stream Deck software** 7.1 or newer — required to run the Elgato plugin
- **HotSpot StreamDock** (or another QT5 SVG Tiny 1.2 compatible Mirabox host) — only required if you're developing or testing the Mirabox plugin
- **UlanziStudio** — only required if you're developing or testing the Ulanzi Deck plugin

## Getting Started

```bash
# Clone the repository
git clone https://github.com/niklam/iracedeck.git
cd iracedeck

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

After the initial install and build, link the plugin to whichever host(s) you're developing against.

### Stream Deck

```bash
# Link the built plugin to the Stream Deck software
pnpm link:stream-deck

# Watch mode — auto-rebuilds on save
pnpm watch:stream-deck
```

Restart the Stream Deck software. The plugin appears in the action list as **iRaceDeck**.

### Mirabox

```bash
# Link the built plugin to the Mirabox host
pnpm link:mirabox

# Watch mode for the Mirabox plugin (no root-level shortcut yet)
pnpm --filter @iracedeck/iracing-plugin-mirabox run watch
```

On Windows, `link:mirabox` defaults to the standard HotSpot StreamDock install path (`%APPDATA%\HotSpot\StreamDock\plugins`). If you're using a different host (e.g. VSD Craft), point `MIRABOX_PLUGINS_DIR` at its plugins directory in `.env.local` (see below).

### Ulanzi Deck

There's no root-level link shortcut for Ulanzi yet. Build the plugin (or run its watcher), then make the built `packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin` folder available to UlanziStudio by copying or symlinking it into `%APPDATA%\Ulanzi\UlanziDeck\Plugins\`, and restart UlanziStudio.

```bash
# Watch mode for the Ulanzi plugin (no root-level shortcut yet)
pnpm --filter @iracedeck/iracing-plugin-ulanzi run watch
```

## `.env.local`

Some dev scripts read per-developer settings from `.env.local` at the repo root. The file is gitignored and never committed. Copy `.env.local.example` as a starting point:

```bash
cp .env.local.example .env.local
```

Keys currently supported:

| Key | Used by | Purpose |
|-----|---------|---------|
| `MIRABOX_PLUGINS_DIR` | `pnpm link:mirabox` / `unlink:mirabox` / `relink:mirabox` | Path to your Mirabox host's plugins directory. Optional on Windows when using HotSpot StreamDock — the scripts default to `%APPDATA%\HotSpot\StreamDock\plugins`. Set this only to override (e.g. `C:\Users\you\AppData\Roaming\VSD Craft\Plugins`). |

## Picking up changes after a rebuild

Both Stream Deck and Mirabox host apps cache plugin metadata aggressively. If your changes affect `manifest.json`, Property Inspector templates, static icons, or the action registration layer, the reliable flow is:

1. **Quit the host software from the task bar** (right-click the tray icon → Quit / Exit). Closing the window is not enough — the app keeps running in the background.
2. Run `pnpm build` (or let your watch process rebuild automatically).
3. Start the host software again.

For pure action-code edits, the watch process plus the host's built-in refresh usually suffices, but when in doubt, run the full stop–build–start cycle.

## Useful Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm build:stream-deck` | Build only the Stream Deck plugin |
| `pnpm watch:stream-deck` | Watch mode — rebuild on file changes (Stream Deck) |
| `pnpm --filter @iracedeck/iracing-plugin-mirabox run watch` | Watch mode for the Mirabox plugin |
| `pnpm --filter @iracedeck/iracing-plugin-ulanzi run watch` | Watch mode for the Ulanzi Deck plugin |
| `pnpm link:stream-deck` | Register the plugin with Stream Deck |
| `pnpm unlink:stream-deck` | Unregister the Stream Deck plugin |
| `pnpm relink:stream-deck` | Unlink + link Stream Deck (useful when switching branches) |
| `pnpm link:mirabox` | Register the plugin with the Mirabox host (uses `MIRABOX_PLUGINS_DIR` if set, otherwise the Windows HotSpot StreamDock default) |
| `pnpm unlink:mirabox` | Unregister the Mirabox plugin |
| `pnpm relink:mirabox` | Unlink + link Mirabox (useful when switching branches) |
| `pnpm switch-test-env` | Install + build + relink for both platforms |
| `pnpm switch-test-env:stream-deck` | Install + build + relink only Stream Deck |
| `pnpm switch-test-env:mirabox` | Install + build + relink only Mirabox |
| `pnpm test` | Run all tests |
