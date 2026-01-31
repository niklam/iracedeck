# iRaceDeck

Open source iRacing button box plugin for Elgato Stream Deck. Turn your Stream Deck into a powerful button box with live telemetry displays and customizable racing controls.

## What is iRaceDeck?

iRaceDeck transforms your Elgato Stream Deck into a virtual button box for iRacing. Display live telemetry data, monitor race information, and create custom racing controls - all on your Stream Deck's programmable buttons.

## Features

### Current Actions

**Vehicle Displays:**

- **Speed Display**: Shows current speed in MPH or KPH (press to toggle units)
- **Gear Display**: Shows current gear (R, N, 1-9)

**Pit Service:**

- **Fuel to Add**: Display and toggle fuel fill
- **Add/Reduce Fuel**: Adjust pit fuel amount
- **Tire Compound**: Toggle between dry and wet tires
- **Change Tires**: Configure which tires to change
- **Fast Repair**: Toggle fast repair

**Environment:**

- **Sky Conditions**: Display current weather

**Communications:**

- **Chat Message**: Send custom chat messages to iRacing

### Technical Features

- Real-time updates (10 times per second)
- Automatic connection/reconnection to iRacing
- Native C++ addon for maximum performance
- Windows-only (iRacing is Windows-only)

## Installation

### For Users

1. Download the latest release `.streamDeckPlugin` file
2. Double-click the file to install
3. The plugin will appear in your Stream Deck software under the "iRaceDeck" category

### For Developers

#### Prerequisites

- Node.js 20 or later
- pnpm 10 or later
- Windows 10 or later
- Python 3.x (for building native addon)
- Visual Studio Build Tools with C++ workload
- Elgato Stream Deck software
- iRacing installed (for testing)

#### Setup

```bash
# Clone the repository
git clone <your-repo-url>
cd iRaceDeck

# Install dependencies
pnpm install

# Build all packages
pnpm run build
```

#### Development

```bash
# Build specific packages
pnpm --filter @iracedeck/iracing-sdk run build
pnpm build:stream-deck

# Watch mode (if configured)
pnpm run dev
```

## Project Structure

This is a pnpm monorepo managed with Turborepo:

```
iRaceDeck/
├── packages/
│   ├── iracing-native/           # @iracedeck/iracing-native
│   │   ├── src/
│   │   │   ├── addon.cc          # C++ N-API addon
│   │   │   └── index.ts          # TypeScript wrapper
│   │   ├── binding.gyp           # Native build config
│   │   └── package.json
│   │
│   ├── iracing-sdk/              # @iracedeck/iracing-sdk
│   │   ├── src/
│   │   │   ├── IRacingSDK.ts     # Main SDK class
│   │   │   ├── types.ts          # iRacing type definitions
│   │   │   ├── commands/         # Broadcast commands (Pit, Chat, etc.)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── stream-deck-shared/        # @iracedeck/stream-deck-shared
│   │   └── ...                    # Shared utilities, PI components, types
│   │
│   └── stream-deck-plugin-core/   # @iracedeck/stream-deck-plugin-core
│       ├── src/
│       │   ├── plugin.ts         # Plugin entry point
│       │   └── actions/          # Stream Deck actions
│       ├── com.iracedeck.sd.core.sdPlugin/
│       │   ├── manifest.json     # Plugin metadata
│       │   ├── bin/              # Compiled output
│       │   └── imgs/             # Plugin icons
│       └── package.json
│
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── package.json
```

### Package Overview

| Package                              | Description                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `@iracedeck/iracing-native`          | C++ Node.js addon for Win32 APIs (memory-mapped files, window messaging) |
| `@iracedeck/iracing-sdk`             | TypeScript SDK for iRacing telemetry and broadcast commands              |
| `@iracedeck/stream-deck-shared`      | Shared utilities, PI components, and types for Stream Deck plugins       |
| `@iracedeck/stream-deck-plugin-core` | Core Stream Deck plugin with driving/interface actions                    |

## Technical Architecture

### Native Addon (`@iracedeck/iracing-native`)

The native addon provides low-level access to Windows APIs:

- **Memory-Mapped Files**: Open and read iRacing's shared memory
- **Window Messaging**: Send broadcast messages, WM_CHAR for chat
- **Win32 Functions**: FindWindow, RegisterWindowMessage, SendNotifyMessage

### SDK (`@iracedeck/iracing-sdk`)

The SDK provides a clean TypeScript API:

- **IRacingSDK**: Main class for connecting and reading telemetry
- **Commands**: PitCommand, ChatCommand, CameraCommand, etc.
- **Types**: Full TypeScript definitions for iRacing data structures

### Plugin (`@iracedeck/stream-deck-plugin-core`)

The core Stream Deck plugin:

- **Actions**: Individual Stream Deck button implementations
- **ConnectionStateAwareAction**: Base class handling iRacing connection state
- Uses Rollup to bundle for the Stream Deck runtime

## Available Telemetry Variables

The iRacing SDK provides access to hundreds of telemetry variables. Some useful ones:

- `Speed`: Vehicle speed (m/s)
- `Gear`: Current gear (-1 = R, 0 = N, 1+ = forward)
- `RPM`: Engine RPM
- `FuelLevel`: Fuel level (liters)
- `PitSvFuel`: Fuel to add at pit stop
- `PitSvFlags`: Pit service flags (tires, fuel, fast repair)
- `Throttle`: Throttle position (0-1)
- `Brake`: Brake position (0-1)
- `LapCurrentLapTime`: Current lap time (seconds)
- `SessionTimeRemain`: Time remaining in session

## Adding New Actions

1. Create a new action file in `packages/stream-deck-plugin-core/src/actions/`
2. Extend `ConnectionStateAwareAction` from `@iracedeck/stream-deck-shared`
3. Register the action in `packages/stream-deck-plugin-core/src/plugin.ts`
4. Add action metadata to `manifest.json`
5. Add icons to the `imgs/actions/` folder

Example:

```typescript
import streamDeck, { action, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";

import { SDKController } from "../sdk-controller";

@action({ UUID: "com.iracedeck.sd.rpm" })
export class RPMDisplay extends SingletonAction {
  private sdkController = SDKController.getInstance();

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
  }

  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean) {
    const action = streamDeck.actions.getActionById(contextId);
    if (!action) return;

    if (!isConnected) {
      await action.setTitle("iRacing\nnot\nconnected");
    } else if (telemetry?.RPM) {
      await action.setTitle(Math.round(telemetry.RPM).toString());
    } else {
      await action.setTitle("N/A");
    }
  }
}
```

## Troubleshooting

### Plugin doesn't connect to iRacing

- Ensure iRacing is running and in a session (on track)
- Check that you're on Windows (macOS/Linux not supported)
- iRacing's telemetry is only available when actively driving

### Build errors with native addon

- Ensure Python 3.x is installed and in PATH
- Install Visual Studio Build Tools with "Desktop development with C++"
- Set `msvs_version` if using a non-standard VS version:
  ```bash
  npm config set msvs_version 2022
  ```

### Display shows "N/A"

- iRacing is not running or not in a session
- The plugin will automatically reconnect when iRacing starts

## License

MIT

## Credits

Built with:

- [Elgato Stream Deck SDK](https://github.com/elgatosf/streamdeck)
- [Node-API (N-API)](https://nodejs.org/api/n-api.html) - Native addon API
- [iRacing SDK](https://forums.iracing.com/discussion/15068/official-iracing-sdk) - Official iRacing telemetry API
- Reference: [pyirsdk](https://github.com/kutu/pyirsdk) - Python iRacing SDK implementation

## Contributing

Contributions are welcome! Feel free to:

- Add new actions for different telemetry data
- Improve error handling
- Add configuration options
- Create better icons
- Write documentation

Please open an issue or pull request on GitHub.
