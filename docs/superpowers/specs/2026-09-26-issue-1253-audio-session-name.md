# Audio session name and icon in the Windows Volume Mixer

> **Issue:** [#1253](https://github.com/niklam/iracedeck/issues/1253) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Windows labels each audio session in the Volume Mixer with the name and icon the owning app set on it, and falls back to the owning executable's `FileDescription` and icon when the app set none. Our stream is opened by `@iracedeck/audio-native` (miniaudio over WASAPI, shared mode, the process's default session), inside the `node.exe` each deck host bundles. miniaudio never names the session, so the mixer shows "Node".

## Decision

Name the session ourselves through the Core Audio session API, from the native addon.

- After every successful `ma_engine_init`, take the playback `IAudioClient` from `ma_engine_get_device(g_engine)->wasapi.pAudioClientPlayback`, call `GetService(IID_IAudioSessionControl)`, then `SetDisplayName` and (when an icon path is known) `SetIconPath`, and release the control. The event-context GUID argument is `NULL`: nothing of ours listens for session events.
- **Reapply on every engine creation.** The engine is torn down after the idle window and recreated on the next play (#849), and the device fallback in `ensureEngineCreated` is a second init path. Both go through one helper, so neither can skip the identity.
- **Reapply on reroute.** A session belongs to one endpoint. When miniaudio follows a default-device change it initializes a new `IAudioClient` on the new endpoint, whose session has no name. The engine config's `notificationCallback` reapplies the identity on `ma_device_notification_type_rerouted`. miniaudio performs the reroute, and so fires that callback, from its `IMMNotificationClient` handler, on a Windows device-notification thread in the multithreaded apartment, where calling the session API is allowed; the identity strings it reads are set once before the first engine creation and never mutated afterwards, so no lock is needed, but the setter refuses to change them while an engine exists.
- **Failure is silent and harmless.** Every HRESULT is checked; a failure leaves the Windows default ("Node") and never fails engine creation or playback. Off Windows (miniaudio on another backend) the helper is a no-op, and the TS mock records the identity for tests.

### The seam

- `audio-native` exports `setSessionIdentity(displayName: string, iconPath?: string)`: it stores UTF-16 copies for the helper above. The `AudioNative` class and `mock-impl.ts` gain the same method; the mock stores its arguments.
- `audio-service`'s `initializeAudio` takes the identity as an optional fourth argument (`{ displayName, iconPath? }`) and passes it to the native layer before any engine exists. Optional, so the scenario harness and tests need no change.
- Each plugin's `plugin.ts` passes `displayName: "iRaceDeck"` and `iconPath: join(__binDir, "..", "imgs", "plugin", "iracedeck.ico")` — resolved from `__binDir` like `audioRootDir`, so it is absolute and independent of the host's cwd. `SetIconPath` requires an absolute path.

The name is a constant, not a setting, and not per ecosystem: the product is iRaceDeck on all three hosts.

### The icon

`assets/favicon/favicon.ico` already exists (the website favicon, from the rebrand in `feb02e8fd`): 16, 32 and 48 px, 32-bit with alpha, which covers the mixer at 100–200 % scaling (Windows scales 32 → 24 for 150 %). It is copied verbatim into each plugin as `imgs/plugin/iracedeck.ico`, next to the committed `marketplace.png` that follows the same per-plugin pattern. A test asserts all three copies are byte-identical to the source, so a logo change cannot update one plugin and not the others. At about 15 KB it is irrelevant to Mirabox's distributable cap.

## Alternatives rejected

- **Renaming or re-stamping `node.exe`.** It is the deck host's binary, shared by every plugin it runs; we do not own it.
- **`process.title`.** Changes the console title only; the mixer never reads it.
- **Our own session GUID** (`pAudioSessionGuid` on `IAudioClient::Initialize`). miniaudio passes `NULL` and offers no option for it; patching the vendored header for a benefit we do not need (separating our streams into several sessions) is a maintenance cost with no return. The default per-process session is exactly one mixer row, which is what we want.
- **Generating a new `.ico` from `favicon.svg`** (for example through `@iracedeck/rasterizer`). It would add a generator and a freshness test to produce what the existing file already contains. Revisit only if the mixer is seen rendering the icon blurry at a scale the three sizes do not cover.

## Out of scope

- The mixer's per-app volume memory. Windows keys it on the executable path, so it is shared with anything else the same host's `node.exe` plays; naming the session does not change that.
- macOS and the mocked platforms: no mixer to name.
- The scenario harness, which runs under a plain `node` and may keep the default name.

## Testing

- **Unit:** `audio-service` passes the identity to the native layer before the first `startEngine`, and passes nothing when none is given; the mock records `setSessionIdentity`. The icon-copy guard compares each plugin's `imgs/plugin/iracedeck.ico` with `assets/favicon/favicon.ico`.
- **Manual (Windows, each host the maintainer has):** trigger a callout, then check the row reads "iRaceDeck" with the logo in both the classic mixer (`sndvol.exe`) and Windows 11 Settings → System → Sound → Volume mixer. Then (1) let the idle teardown release the device and play again; (2) change the default output device while audio plays; (3) pick a specific device in the plugin's audio settings. The name and icon must survive all three.
