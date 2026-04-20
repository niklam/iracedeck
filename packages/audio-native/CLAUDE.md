# @iracedeck/audio-native

Native Node.js addon (C++/N-API) around the miniaudio single-header library. Provides a 4-channel mixer with per-channel volume, looping, completion callbacks, and device selection.

## Cross-platform architecture

The package detects the platform at module load and behaves accordingly:

- **Windows (`win32`)**: loads the native `.node` addon via `createRequire()`. If the addon is missing (e.g. fresh clone without `node-gyp rebuild`), falls back to the mock.
- **Other platforms**: skips native addon loading entirely and uses `AudioNativeMock`.

The `AudioNative` class delegates every method call to either `addon` (native) or `AudioNativeMock`. Consumers never need to know which is active.

### Build behavior

`scripts/build.mjs` is platform-aware:
- On Windows: runs `node-gyp rebuild` then `tsc`
- On macOS/Linux: runs `tsc` only (skips native compilation)

### Mock implementation

`AudioNativeMock` (in `src/mock-impl.ts`) returns success for every method but produces no audio. `getAudioDevices()` returns a single entry named `Mock Audio Device`.

### When adding new native methods

1. Update `addon.cc` — C++ implementation + register in `Init()`
2. Update `src/index.ts` — add corresponding TypeScript method to `AudioNative` class
3. Update `src/mock-impl.ts` — add matching no-op in `AudioNativeMock`
4. Update `src/mock-impl.test.ts`
5. Update `packages/deck-core/src/audio-service.ts`'s `AudioEngineCallbacks` interface if the new method is meant to be consumed by the audio service

## Audio engine functions

The addon embeds miniaudio for multi-channel mixing. 4 independent channels with per-channel volume, looping, and completion callbacks via `ThreadSafeFunction`.

### `initAudioEngine(): boolean`
Creates an `ma_engine` (WASAPI shared mode on Windows). Returns `true` on success.

### `destroyAudioEngine(): void`
Uninitializes all sounds and the engine.

### `playOnChannel(channel: number, filePath: string, loop?: boolean, volume?: number): boolean`
Plays a file on a specific channel (0–3). Stops any existing sound on that channel first. Supports WAV, MP3, FLAC.

### `stopChannel(channel: number): void`
Stops and releases the sound on a channel.

### `setChannelVolume(channel: number, volume: number): void`
Sets per-channel volume (0.0–1.0). Only works on an existing `ma_sound`.

### `isChannelPlaying(channel: number): boolean`
Checks if a channel has active playback.

### `setChannelEndCallback(channel: number, callback: () => void): void`
Registers a JS callback via TSFN that fires when a sound finishes playing.

### `stopAllChannels(): void`
Stops all 4 channels.

### `seekChannelRandom(channel: number): void`
Seeks to a random position in the current sound (used for ambient loop variation).

### `getAudioDevices(): Array<{ index: number, name: string, isDefault: boolean }>`
Enumerates available audio playback devices.

### `setAudioDevice(deviceIndex: number): boolean`
Switches audio output to a specific device. -1 for system default. Stops all sounds and reinitializes the engine.

## Channel enum

```ts
export enum AudioChannel {
  Ambient = 0,
  SFX = 1,
  Voice = 2,
  Spotter = 3,
}
```

The same enum is also defined in `@iracedeck/deck-core`'s `audio-service.ts` for consumer convenience. Stage 2 of the audio rollout consolidates the two.

## License

See `LICENSE` at the repo root.
