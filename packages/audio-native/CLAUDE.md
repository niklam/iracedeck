# @iracedeck/audio-native

Native Node.js addon (C++/N-API) around the miniaudio single-header library. Provides a 4-channel mixer with per-channel volume, looping, completion callbacks, and device selection.

## Cross-platform architecture

The package detects the platform at module load and behaves accordingly:

- **Windows (`win32`)**: loads the native `.node` addon via `createRequire()`. If the addon is missing (e.g. fresh clone without `node-gyp rebuild`), falls back to the mock.
- **Other platforms**: skips native addon loading entirely and uses `AudioNativeMock`.
- **Force mock**: setting `IRACEDECK_MOCK=1` in the environment or creating a `.mock` file in the process cwd (the sdPlugin folder) forces the mock even on Windows.
- **The test suite already sets it (#1084).** `vitest.config.ts` sets `test.env.IRACEDECK_MOCK`, so test **workers** — and any child process they spawn — never load this package's `.node`. The main Vitest process is not covered; see `iracing-native/CLAUDE.md` for why that matters. No test reaches this package today — every test import of it is type-only — but the lever covers both native packages. Use `IRACEDECK_REAL_NATIVE=1` to opt back in.

The `AudioNative` class delegates every method call to either `addon` (native) or `AudioNativeMock`. Consumers never need to know which is active.

### Build behavior

`scripts/build.mjs` is platform-aware:
- On Windows: runs `node-gyp rebuild` then `tsc`
- On macOS/Linux: runs `tsc` only (skips native compilation)

A running deck host has `build/Release/audio_native.node` loaded, and Windows refuses to delete a loaded image, which node-gyp's clean step needs. So before `node-gyp rebuild` (and `node-gyp clean`, in `scripts/clean.mjs`) the script deletes the binary itself, and when that fails with `EPERM`/`EBUSY`/`EACCES` it **moves** it into the package's gitignored `.locked-native/` folder — Windows allows moving a loaded image on the same volume, and the host keeps running the old code from the moved file until it restarts. The rebuild then always produces a fresh binary; there is no catch around it, so any build failure is a real one. Keeping the old binary instead would let turbo cache the stale `.node` under the new sources' hash (#1258). Each native build or clean sweeps the moved copies a host has since released; a cache-hit build runs no script, so they can sit there until then. The step is the shared `scripts/lib/native-addon-build.mjs`, used by `iracing-native` too and named as a turbo input of both packages' `build`; spec `docs/superpowers/specs/2026-10-03-issue-1258-native-build-locked-addon.md`.

The `install` script in `package.json` is a no-op `echo`, so `pnpm install` never triggers node-gyp — building the addon is explicit-only via `pnpm build`.

### Mock implementation

`AudioNativeMock` (in `src/mock-impl.ts`) produces no audio and returns success for most methods, with two deliberate exceptions:

- `isChannelPlaying()` always returns `false` (nothing ever actually plays).
- `setAudioDeviceById()` returns `true` only for the synthetic id `mock-device-0` — the id of the single `Mock Audio Device` entry returned by `getAudioDevices()`. Any other id returns `false`, mirroring the unknown-device case on real hardware; tests rely on this distinction.

`setSessionIdentity()` also records its arguments on the mock's public `sessionIdentity` field (`null` until called, and again after an empty display name or `destroyAudioEngine()`, as natively), so tests can assert what reached the native layer.

### When adding new native methods

1. Update `addon.cc` — C++ implementation + register in `Init()`
2. Update `src/index.ts` — add corresponding TypeScript method to `AudioNative` class
3. Update `src/mock-impl.ts` — add matching no-op in `AudioNativeMock`
4. Update `src/mock-impl.test.ts`
5. `@iracedeck/audio-service` consumes the `AudioNative` class directly by type (`initializeAudio(logger, native, …)` in `packages/audio-service/src/audio-service.ts`), so a new method is visible there automatically — add the `AudioService` usage there if the method is meant to be consumed by the audio service

## Audio engine functions

The addon embeds miniaudio for multi-channel mixing. 4 independent channels with per-channel volume, looping, and completion callbacks via `ThreadSafeFunction`.

`stopChannel`, `isChannelPlaying`, `stopAllChannels`, and `destroyAudioEngine` do exactly what their names say (see `src/index.ts`); the functions below have behavior worth documenting.

### `initAudioEngine(): boolean`
Creates only the shared `ma_context` (device enumeration). **No `ma_engine` and no OS audio device exist after init** (issue #849): Windows holds a sleep-blocking SYSTEM power request ("An audio stream is currently in use") for a WASAPI stream that merely exists — even initialized-but-stopped — so the engine is created lazily (`startAudioEngine`/`playOnChannel`) and torn down entirely when idle (`stopAudioEngine`). Returns `true` when the context is usable.

### `startAudioEngine(): boolean` / `stopAudioEngine(): boolean`
The device lifecycle pair (issue #849). `startAudioEngine` lazily creates the engine on the remembered device selection (system-default fallback if it vanished — the selection is kept so a replug self-heals) and starts it; `stopAudioEngine` tears the whole engine down, releasing the OS stream and any loaded sounds. Both idempotent. Consumed by `@iracedeck/audio-service`, which starts at the playback-start chokepoint and releases after all channels have been idle for `IDLE_STOP_DELAY_MS` — so sounds are never cut. `playOnChannel` also recreates the engine on demand (the device starts moments later via `startAudioEngine`, and a stopped device just holds the sound at its start).

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
Selects the output device by enumeration index (-1 for system default): validates, remembers the selection, and tears down any live engine — the next play recreates it on the new device (issue #849; recreating eagerly would hold the sleep-blocking power request while idle). Selection identity is compared on stable `ma_device_id` bytes (never the volatile index), so re-selecting the already-active physical device is a no-op. Prefer `setAudioDeviceById` for persisted selections.

### `setSessionIdentity(displayName: string, iconPath?: string): boolean`
Names our audio session in the Windows Volume Mixer, which otherwise shows the host executable's name — "Node" (issue #1253, spec `docs/superpowers/specs/2026-09-26-issue-1253-audio-session-name.md`). Stores UTF-16 copies; `applySessionIdentity` then takes the playback `IAudioClient`'s `IAudioSessionControl` and calls `SetDisplayName` / `SetIconPath` (icon only when given; it must be an absolute `.ico` path). It runs after every successful `ma_engine_init` in `ensureEngineCreated` (the selected-device path and the system-default fallback both), and again after `ma_device_notification_type_rerouted`, because a session belongs to one endpoint and the client miniaudio opens on a new default device carries an unnamed one. **Everything but the notification runs on the JS thread.** miniaudio fires the reroute notification synchronously from its `IMMNotificationClient` handler while holding its reroute lock, and COM work on an `IAudioClient` there can deadlock (its own comment in `ma_device_reinit__wasapi`), so `maNotificationCallback` reads only the notification type and posts through an `Unref`'d `ThreadSafeFunction` (`g_rerouteTSFN`, mutex-guarded like the channel end TSFNs); the JS-thread handler names the session of whatever engine exists by then. So the identity strings and the device are never touched off the JS thread, and `teardownEngine` cannot free a device the handler is reading. The TSFN is created by `setSessionIdentity`, released by `destroyAudioEngine`, and disarmed by an env cleanup hook if Node tears the environment down first. An empty `displayName` clears the identity, icon included, for engines created afterwards (Windows keeps a name already applied to the process's session while that session lives — measured: set, play, clear, replay still shows the name; set, clear, play shows the default); `destroyAudioEngine` clears it too, and `@iracedeck/audio-service` sets it again from `init()`, before any engine can exist. Returns `false` while an engine exists — the live session was named at creation and would keep the old name — and the TypeScript wrapper also returns `false` when the loaded binary predates the method (the TypeScript and the binary are built by separate steps, and before #1258 a host-locked binary survived every rebuild), so a stale binary degrades the feature instead of aborting startup. Every HRESULT failure is silent and leaves the Windows default; engine creation never fails because of it. A no-op on any backend other than WASAPI.

### `setAudioDeviceById(deviceId: string): boolean`
Same as `setAudioDevice` but looks the device up by its stable `id` from `getAudioDevices`. Returns `false` if the id is malformed or not found in the current enumeration (e.g. unplugged device). Should the selected device vanish before the next play, the lazy engine creation falls back to the system default so the mixer remains usable. Use this for any selection that needs to survive replug or driver reset.

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
