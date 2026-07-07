# @iracedeck/audio-native

Native Node.js addon (C++/N-API) around the miniaudio single-header library. Provides a 4-channel mixer with per-channel volume, looping, completion callbacks, and device selection.

## Cross-platform architecture

The package detects the platform at module load and behaves accordingly:

- **Windows (`win32`)**: loads the native `.node` addon via `createRequire()`. If the addon is missing (e.g. fresh clone without `node-gyp rebuild`), falls back to the mock.
- **Other platforms**: skips native addon loading entirely and uses `AudioNativeMock`.
- **Force mock**: setting `IRACEDECK_MOCK=1` in the environment or creating a `.mock` file in the process cwd (the sdPlugin folder) forces the mock even on Windows.

The `AudioNative` class delegates every method call to either `addon` (native) or `AudioNativeMock`. Consumers never need to know which is active.

### Build behavior

`scripts/build.mjs` is platform-aware:
- On Windows: runs `node-gyp rebuild` then `tsc`
- On macOS/Linux: runs `tsc` only (skips native compilation)

A `node-gyp rebuild` failure is treated as recoverable **only** when it is a file-lock error (`EBUSY`/`EPERM`/"in use"-style message — a running Stream Deck / deck host app holding the DLL) **and** an existing `build/Release/audio_native.node` is present to reuse; any other failure rethrows so real build regressions surface. The script is deliberately kept in sync with `iracing-native`'s copy — change both together.

The `install` script in `package.json` is a no-op `echo`, so `pnpm install` never triggers node-gyp — building the addon is explicit-only via `pnpm build`.

### Mock implementation

`AudioNativeMock` (in `src/mock-impl.ts`) produces no audio and returns success for most methods, with two deliberate exceptions:

- `isChannelPlaying()` always returns `false` (nothing ever actually plays).
- `setAudioDeviceById()` returns `true` only for the synthetic id `mock-device-0` — the id of the single `Mock Audio Device` entry returned by `getAudioDevices()`. Any other id returns `false`, mirroring the unknown-device case on real hardware; tests rely on this distinction.

### When adding new native methods

1. Update `addon.cc` — C++ implementation + register in `Init()`
2. Update `src/index.ts` — add corresponding TypeScript method to `AudioNative` class
3. Update `src/mock-impl.ts` — add matching no-op in `AudioNativeMock`
4. Update `src/mock-impl.test.ts`
5. `@iracedeck/audio-service` consumes the `AudioNative` class directly by type (`initializeAudio(logger, native)` in `packages/audio-service/src/audio-service.ts`), so a new method is visible there automatically — add the `AudioService` usage there if the method is meant to be consumed by the audio service

## Audio engine functions

The addon embeds miniaudio for multi-channel mixing. 4 independent channels with per-channel volume, looping, and completion callbacks via `ThreadSafeFunction`.

`stopChannel`, `isChannelPlaying`, `stopAllChannels`, and `destroyAudioEngine` do exactly what their names say (see `src/index.ts`); the functions below have behavior worth documenting.

### `initAudioEngine(): boolean`
Creates an `ma_engine` (WASAPI shared mode on Windows). Returns `true` on success.

### `playOnChannel(channel: number, filePath: string, loop?: boolean, volume?: number): boolean`
Plays a file on a specific channel (0–3). Stops any existing sound on that channel first. Supports WAV, MP3, FLAC.

### `setChannelVolume(channel: number, volume: number): void`
Sets per-channel volume (0.0–1.0). Only works on an existing `ma_sound`.

### `setChannelEndCallback(channel: number, callback: () => void): void`
Registers a JS callback via TSFN that fires when a sound finishes playing.

### `seekChannelRandom(channel: number): void`
Seeks to a random position in the current sound (used for ambient loop variation).

### `getAudioDevices(): AudioDeviceInfo[]`
Enumerates available audio playback devices. `id` is a hex-encoded `ma_device_id` — the platform-stable identifier (WASAPI endpoint ID on Windows, CoreAudio UID on macOS, etc.) suitable for persisting selection across sessions. `index` is the volatile enumeration position retained for backward compatibility. `AudioDeviceInfo` (`{ index, name, id, isDefault }`) is an exported type — it is the persistence contract consumed by the `ird-audio-device-select` PI component, which persists selection by stable `id`, never by `index`.

### `setAudioDevice(deviceIndex: number): boolean`
Switches audio output to a specific device by enumeration index. -1 for system default. Stops all sounds and reinitializes the engine. Prefer `setAudioDeviceById` for persisted selections.

### `setAudioDeviceById(deviceId: string): boolean`
Switches audio output to a device looked up by its stable `id` from `getAudioDevices`. Returns `false` if the id is not found in the current enumeration (e.g. unplugged device). On engine-init failure, falls back to the system default so the mixer remains usable. Use this for any selection that needs to survive replug or driver reset.

## Channel enum

```ts
export enum AudioChannel {
  Ambient = 0, // pit lane background noise (loops)
  SFX = 1, // walkie-talkie open/close ticks
  Voice = 2, // engineer voice messages, reminders, toggles
  Radar = 3, // directional radar ticks (independent)
}
```

The same enum is duplicated in `@iracedeck/audio-service` (`packages/audio-service/src/audio-service.ts`) — keep the two in sync when channels change.
