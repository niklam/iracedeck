# Naming the audio session without touching miniaudio's audio client

> **Issue:** [#1411](https://github.com/niklam/iracedeck/issues/1411) · **Supersedes:** [2026-09-26-issue-1253-audio-session-name.md](2026-09-26-issue-1253-audio-session-name.md), for how the identity is applied; the name and the icon stand · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Since #1253 the addon names our audio session by asking miniaudio's playback `IAudioClient` for its `IAudioSessionControl` (`GetService`) and calling `SetDisplayName` / `SetIconPath` on it. It does that on the JS thread, after every engine creation and after every reroute. A Windows default-device change while the stream is open freezes the plugin for good. The stacks, captured from a frozen plugin on 2026-10-10 and resolved with Microsoft's public symbols, are in the issue:

- **JS thread:** `CAudioClient::GetService` holds the audio client's lock and, creating the session control, calls `CDeviceEnumerator::RegisterEndpointNotificationCallback`, which waits for the device enumerator's notification lock.
- **Windows' notification thread:** holds that lock for the whole of `CallOnDefaultDeviceChanged`, inside which miniaudio's handler is in `ma_device_stop`, waiting for the audio worker to stop.
- **Audio worker:** in `CAudioRenderClient::GetBuffer`, waiting for the audio client's lock.

Two facts make this a rule rather than an accident:

- Creating an `IAudioSessionControl` always registers an endpoint notification callback, so it always needs a lock Windows holds while any `IMMNotificationClient` callback runs.
- Windows reports one default-device change once per role, and miniaudio's handler ignores the role, so one change is several stop / reroute / start rounds back to back. The rename queued by the first reroute runs while the next callback is already stopping the device.

#1253 moved the rename off the notification thread because miniaudio's own comment warns about COM work there. That was not enough: the JS thread is just as unsafe, as long as the call goes through the audio client.

## Decision

### 1. Our threads never call into miniaudio's `IAudioClient`

`applySessionIdentity(ma_device *)` goes. Nothing of ours reads `device->wasapi.pAudioClientPlayback` any more, which also ends the possibility of using a client miniaudio is releasing in a reroute.

### 2. The session is named through a session manager of our own

The stream miniaudio opens belongs to our process's default session on its endpoint (it passes no session GUID). The same session is reachable without the client: our own `IMMDeviceEnumerator`, the endpoint's `IMMDevice`, `Activate(IAudioSessionManager)`, then `GetAudioSessionControl(NULL, 0)`. `SetDisplayName` / `SetIconPath` on that control name the session the stream is in.

Creating that control still waits while a notification callback runs. The difference is what it holds while waiting: nothing the audio worker needs. The worker keeps running, miniaudio's `ma_device_stop` returns, the callback finishes, and the wait ends.

The endpoint is the one the engine is on:

- **System default, or a selected device that could not be opened:** the default render endpoint for the console role, which is what miniaudio opens.
- **A selected device:** that device, by the id miniaudio was given.
- **After a reroute:** the default render endpoint. miniaudio only reroutes an engine it opened on the default.

### 3. On a thread of its own

A small namer thread in the addon does all of it: COM initialised once (multithreaded), woken by a request, exiting on a stop flag. Requests carry the endpoint and are coalesced, so a burst of them is one rename of the latest target.

- **At engine creation**, the JS thread posts a request once the engine exists. It is served at once.
- **On a reroute**, miniaudio's notification callback posts a request. It takes the namer's mutex for a moment and does no COM work, so it is safe where it runs. A reroute request is served 500 ms after the last one arrived, because reroutes come in rounds and there is no point naming a session the next round replaces.

So the JS thread never waits on a Windows audio lock for the name, whatever Windows is doing. If a rename does have to wait, the cost is a session that shows the host's name in the Volume Mixer a little longer.

The identity strings move behind the namer's mutex: the JS thread writes them in `setSessionIdentity`, the namer reads a copy.

### 4. What stays

- **`setSessionIdentity`'s contract**, and `@iracedeck/audio-service`: unchanged.
- **The reroute TSFN and `Audio device rerouted`** (#1330): unchanged. The handler now only calls the registered JS callback, so the line is no longer the last thing before a COM call, just the record of a reroute. The TSFN exists while a callback is registered, and no longer because an identity is set.
- **Failures are silent**, as before: the session keeps the host's name and playback is never affected.

### 5. Shutdown

`destroyAudioEngine` and the environment cleanup hook stop the namer and join it. A namer that is waiting on Windows at that moment finishes when the callback it waits for does, and none of those callbacks waits for the JS thread.

## Alternatives considered

- **Keep the rename on the audio client, on another thread:** the three-way cycle stays, with the helper in place of the JS thread. The plugin would keep running with its audio dead.
- **Drop the rename after a reroute:** removes the reliable trigger and leaves the same lock order at every device open. It also leaves the session unnamed after a default switch, for the whole session once #1347 holds the device.
- **Turn off miniaudio's automatic rerouting and follow default changes ourselves:** a much larger change, and the rename at creation would still go through the client.
- **Name every endpoint's session once at start and keep the controls:** no rename would ever be needed, but each held control keeps an idle "iRaceDeck" entry in the Volume Mixer of every device, and a device plugged in later would still need one.
- **Patch miniaudio to honour the role:** fewer rounds, same lock order.

## Out of scope

- **miniaudio's handling of the role**, and the stop / reroute / start it does on Windows' notification thread.
- **The main thread waiting in `ma_engine_start` during a reroute**, which #1347's per-sound check can do. It is bounded by the reroute and belongs to that issue.
- **macOS and Linux:** the identity is Windows-only and the mock is untouched.

## Testing

No unit test can reach this: the code is COM on a live device, and the suite runs against the native mock. The TypeScript side does not change, so its tests stand as they are.

- **A probe script, committed with the addon:** it opens the device with a session identity, keeps it open, and prints a heartbeat, so a stalled event loop shows as a gap. It is the repeatable way to check this code after a miniaudio upgrade or any later change here.
- **Manual, before the fix (the control):** with the probe running on the current addon, changing the Windows default output device stops the heartbeat.
- **Manual, after:**
  - The probe survives 20 default-device changes in a row, some of them seconds apart and some as fast as the picker allows, and its session reads "iRaceDeck" with the icon on the new device each time, in the classic mixer (`sndvol.exe`) and in Settings.
  - In the plugin: a Settings **Test** sound, then a default change inside the 5 s the device stays open. The plugin keeps responding and the log shows `Audio device rerouted` with nothing from the watchdog after it.
  - A specific Output Device selected in the plugin: its session is named on that device.
  - Quitting the deck host while a sound plays leaves no plugin process behind.
  - On the #1347 branch, rebased over this: a default change mid-session, several times.
