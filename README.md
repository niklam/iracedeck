<p align="center">
  <img src="assets/iracedeck-logo-full-white.png" alt="iRaceDeck" width="400">
</p>

<p align="center">
  Open-source <a href="https://www.elgato.com/stream-deck">Elgato Stream Deck</a> and <a href="https://miraboxbuy.com/">Mirabox</a> plugin for <a href="https://www.iracing.com/">iRacing</a>. Turn your Stream Deck or Mirabox into a fully-featured button box with live telemetry, pit controls, camera management, and more.
</p>

<p align="center">
  <a href="https://coderabbit.ai"><img src="https://img.shields.io/coderabbit/prs/github/niklam/iracedeck?utm_source=oss&utm_medium=github&utm_campaign=niklam%2Firacedeck&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews" alt="CodeRabbit Pull Request Reviews"></a>
  <a href="https://discord.gg/c6nRYywpah"><img src="https://img.shields.io/discord/1477659500851888219?logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
</p>

## Features

**32 actions** with **349 controls** across 8 categories, all with Stream Deck+ encoder support:

| Category | Actions | Controls | Examples |
|----------|---------|----------|---------|
| **Display & Session** | 2 | 7 | Incidents, laps, position, fuel, flags |
| **Driving Controls** | 5 | 39 | AI spotter, audio, black box cycling, look direction, car control |
| **Cockpit & Interface** | 4 | 30 | Wipers, FFB, splits & reference, telemetry, UI toggles |
| **View & Camera** | 8 | 124 | FOV, replay transport, camera focus, broadcast tools |
| **Media** | 1 | 7 | Video recording, screenshots |
| **Pit Service** | 3 | 15 | Fuel, tires, compounds, tearoff, fast repair |
| **Car Setup** | 7 | 79 | Brakes, chassis, aero, engine, fuel mix, hybrid/ERS, traction control |
| **Chat** | 2 | 48 | Chat, macros, whisper, reply, race admin commands |

**Key highlights:**

- Live telemetry at 4 Hz with automatic iRacing connection/reconnection
- All keyboard shortcuts are user-configurable via the Property Inspector
- SDK-first design: uses iRacing broadcast commands where possible, keyboard simulation only as fallback
- Native C++ addon for low-latency Win32 API access

## Installation

### Users

1. Download the latest `.streamDeckPlugin` release
2. Double-click to install
3. Find **iRaceDeck** in the Stream Deck action list

### Developers

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

#### Development workflow

```bash
# Build only the Stream Deck plugin packages
pnpm build:stream-deck

# Watch mode with hot-reload (restarts Stream Deck automatically)
pnpm watch:stream-deck

# Run tests
pnpm test

# Lint and format
pnpm lint:fix
pnpm format:fix
```

## Project Structure

A pnpm monorepo built with [Turborepo](https://turbo.build/):

```text
packages/
  actions/                 Platform-agnostic action implementations
  deck-adapter-elgato/     Elgato Stream Deck adapter (bridges Elgato SDK to deck-core)
  deck-adapter-mirabox/    Mirabox VSD Craft adapter (WebSocket protocol to deck-core)
  deck-core/               Platform-agnostic base classes, types, and shared utilities
  icons/                   SVG icon templates (Mustache)
  iracing-native/          C++ N-API addon (shared memory, window messaging, scan codes)
  iracing-sdk/             TypeScript SDK (telemetry, broadcast commands, session parsing)
  logger/                  Shared logger interface
  mirabox-plugin/          Mirabox device plugin
  stream-deck-plugin/      Elgato Stream Deck plugin
  website/                 Documentation website (iracedeck.com)
```

| Package | Role |
|---------|------|
| `@iracedeck/actions` | All 28 action implementations, platform-agnostic |
| `@iracedeck/deck-core` | Base classes, types, keyboard service, icon templates, global settings |
| `@iracedeck/deck-adapter-elgato` | Bridges the Elgato SDK to deck-core's `IDeckPlatformAdapter` interface |
| `@iracedeck/deck-adapter-mirabox` | Bridges the Mirabox VSD Craft WebSocket protocol to deck-core |
| `@iracedeck/icons` | SVG icon Mustache templates with colorization support |
| `@iracedeck/iracing-native` | C++ Node.js addon for Win32 APIs (memory-mapped files, window messaging, scan-code input) |
| `@iracedeck/iracing-sdk` | TypeScript SDK for reading telemetry and sending iRacing broadcast commands |
| `@iracedeck/logger` | Shared logging interface with scoped loggers |
| `@iracedeck/stream-deck-plugin` | Elgato Stream Deck plugin — registers actions, PI templates, manifest |
| `@iracedeck/mirabox-plugin` | Mirabox plugin — registers the same actions for Mirabox devices |
| `@iracedeck/website` | Documentation website at [iracedeck.com](https://iracedeck.com) |

### How it fits together

```text
Button press (Stream Deck or Mirabox)
  -> adapter (deck-adapter-elgato or deck-adapter-mirabox)
    -> actions (platform-agnostic action handler)
      -> deck-core (keyboard service / SDK commands)
        -> iracing-sdk (broadcast command) or iracing-native (scan-code keystroke)
          -> iRacing

iRacing telemetry (shared memory)
  -> iracing-native (reads memory-mapped file)
    -> iracing-sdk (parses telemetry buffer, 4 Hz update loop)
      -> deck-core (notifies subscribers)
        -> actions (updates button display via adapter)
```

## Releasing

All packages share a single version number. Releases are automated using [release-it](https://github.com/release-it/release-it) with the conventional-changelog plugin.

### How to release

```bash
pnpm release            # auto-detect version bump from commits
pnpm release -- 2.0.0   # force a specific version
pnpm release:dry        # preview without making changes
```

The release script will:

1. Analyze conventional commits since the last tag to determine the version bump (`fix` = patch, `feat` = minor, `BREAKING CHANGE` = major)
2. Update `CHANGELOG.md` with grouped entries (Features, Bug Fixes, etc.)
3. Bump the version in the root `package.json`, all `packages/*/package.json` files, and the Stream Deck `manifest.json`
4. Create a commit (`chore(release): vX.Y.Z`), git tag (`vX.Y.Z`), and push to origin
5. Create a GitHub Release with the changelog as release notes

### Stream Deck plugin pack (CI)

A GitHub Actions workflow (`.github/workflows/release-pack.yml`) triggers automatically when a version tag is pushed. It:

1. Builds the full project on Windows
2. Packs the Stream Deck plugin using `streamdeck pack`
3. Attaches the `iracedeck-vX.Y.Z.streamDeckPlugin` file to the GitHub Release

### Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) must be authenticated — the release script reads your token via `gh auth token`

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repo and create a branch (`feature/123-your-feature`)
2. Follow [conventional commits](https://www.conventionalcommits.org/) with package scope (e.g. `feat(stream-deck-plugin): add new action`)
3. Add tests for new code (Vitest)
4. Make sure `pnpm build` and `pnpm test` pass
5. Open a pull request

### Adding a new action

Actions live in `packages/actions/src/actions/`. Each action needs:

1. An action class extending `ConnectionStateAwareAction` from `@iracedeck/deck-core`
2. Icons in `packages/icons/`
3. Registration in both `stream-deck-plugin/src/plugin.ts` and `mirabox-plugin/src/plugin.ts`
4. Manifest entry in each plugin's `manifest.json`
5. A Property Inspector template (EJS -> HTML) in `stream-deck-plugin/src/pi/`
6. Unit tests

See the existing actions for reference, or check `packages/stream-deck-plugin/CLAUDE.md` for step-by-step instructions.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Double-clicking `.streamDeckPlugin` doesn't install | Rename the file to add `.zip` at the end, extract the contents to `%APPDATA%\Elgato\StreamDeck\Plugins`, and restart Stream Deck |
| Plugin doesn't connect | Make sure iRacing is running and you're in a session (on track) |
| Buttons show nothing | iRacing telemetry is only available while driving; the plugin reconnects automatically |
| Native addon build fails | Install Python 3.x and VS Build Tools with C++ workload. Try `npm config set msvs_version 2022` |
| Key presses don't work | Check your key bindings in the Property Inspector match your iRacing configuration |

## License

[MIT](LICENSE)

## Inspiration

This project was inspired by [iRaceIT](https://iraceit.itxware.de/), a Stream Deck plugin for iRacing.

## Acknowledgements

- [Elgato Stream Deck SDK](https://github.com/elgatosf/streamdeck)
- [iRacing SDK](https://forums.iracing.com/discussion/15068/official-iracing-sdk)
- [Node-API (N-API)](https://nodejs.org/api/n-api.html)
- [pyirsdk](https://github.com/kutu/pyirsdk) (reference implementation)
