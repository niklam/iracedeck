# Audio session hold

> **Issue:** [#1347](https://github.com/niklam/iracedeck/issues/1347) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Since #849 the audio engine is created on the first sound and torn down `IDLE_STOP_DELAY_MS` (5 s) after every channel goes idle. That keeps Windows free to sleep, but in a race it means one device open per burst of callouts: 16 in 18 minutes of one AI race on 2026-10-04. Each open initialises the audio driver. A user's report of packet loss plus mouse stutter that stopped with the Race Engineer off (Discord, 2026-10-04) fits driver latency from exactly that churn. It is not proven; LatencyMon on his machine would tell.

## Decision

### 1. Two modes of one engine: on demand, and held

- **On demand** stays the base and is unchanged. A sound opens the device when it is closed, and the idle timer closes it 5 s after every channel is idle. Offline key presses, the Settings window's **Test** buttons and the Background preview all keep this behaviour.
- **Held**: while one or more holds are taken, the audio service keeps the engine created and started and never arms the idle stop. Releasing the last hold arms the ordinary idle stop. If a sound is still playing, the device closes 5 s after it ends, exactly as on demand.

### 2. The audio service owns the hold, not the reason for it

`IAudioService` gains `hold(reason: string)` and `release(reason: string)`, a set of reason strings, so two holders cannot release each other's hold.

- **`hold`:** cancels any pending idle stop and starts the engine now, through the same start path as playback, so the identity, reroute and device-selection handling stay single. A failed start is logged as `WARN Audio device could not be held open; sounds will open it on demand`. The hold stays recorded, so the next play still opens the device on demand and the engine stays up once it has.
- **`release`:** when the last reason goes, arms the idle stop. Releasing an unknown reason is a no-op.
- **Logs:** `INFO Audio device held open` and `INFO Audio device hold released`, with the reason at debug. The held line names no session, because the service owns the hold and not the reason for it. It is written once per hold, when the device is held and up: at the hold, or after a failed start at the sound that opens the device. The existing `Audio device started` and `Audio device stopped (idle)` lines are unchanged.
- **Device-setting change while held:** `setAudioDevice` / `setAudioDeviceById` already tear the engine down. When a hold is active they start it again at once on the new device, rather than leaving it closed until the next sound. System Default needs nothing, because miniaudio's reroute follows Windows.
- **`destroy()`** clears every hold.

### 3. The plugin decides when to hold

A small controller in `iracing-actions/src/audio/`, beside the feature-gate side effects there, takes the hold with reason `"iracing-session"` when both of these are true, and releases it as soon as either is false:

- **iRacing is running.** It reads app-monitor's `onIRacingStarted` and `onIRacingTerminated` (#1338), with `isIRacingActive()` for the state at startup. A plugin started with iRacing already running takes the hold at once. The started edge fires at iRacing's **launch** event, the plugin's quietest moment, about 25–60 s before telemetry connects. Opening at connect instead would put the open into the busiest moment of the run, where both #1330 freezes happened.
- **The Race Engineer or the Radar master gate is on.** With both off, nothing plays during a session and a held stream would only cost. The controller reacts to gate changes through `onGlobalSettingsChange`, read live, so toggling either gate mid-session takes or releases the hold.

The controller has its dependencies injected (app-monitor hooks, gate readers, the audio service), so it imports nothing across the #1176 seam. `plugin-runtime`'s `startServices` phase starts it right after `initAppMonitor`, which is after `getAudio().init()`; since #1349 that phase is the bootstrap the three `plugin.ts` shells share.

### 4. What the hold changes for #849 and #1330

- **#849, sleep:** a held stream keeps Windows' "audio stream in use" power request alive. It does so only while iRacing runs, when the PC is not idle anyway. On iRacing exit the hold is released and the 5 s idle stop closes the device.
- **#1253 and #1330, the reroute rename:** with the device open all session, every Windows default-device switch during a session reaches a live stream, so miniaudio reroutes and the session rename runs on the main thread. Since #1330 each one logs `INFO Audio: Audio device rerouted` before the rename, and the watchdog reports any stall, so a problem here is visible in a support log.

## Out of scope

- **Changing `IDLE_STOP_DELAY_MS`** or the on-demand rules.
- **Per-channel or per-bus device streams.**
- **Proving the DPC theory.** The change removes the churn either way. Whether it was the reporter's cause is answered by his LatencyMon run.
- **Holding during iRacing's replays outside a session.** "iRacing running" is the condition, whatever the sim is showing.

## Testing

- **audio-service (unit, native mock):**
  - `hold` starts the engine and cancels a pending idle stop.
  - No idle stop arms while held, however long the channels stay idle.
  - `release` of the last reason arms it, and the engine stops 5 s later with fake timers.
  - Two reasons need both releases.
  - An unknown release is a no-op.
  - A failed start while holding warns once and leaves on-demand playback working.
  - A device-setting change while held restarts the engine on the new device; while not held it stays closed as today.
  - `destroy` clears holds.
- **Controller (unit):**
  - iRacing start with a gate on gives one hold; with both gates off, none.
  - Turning a gate on or off mid-session takes or releases the hold.
  - iRacing exit releases it.
  - Starting with iRacing already running takes it at once.
  - A throwing listener is contained.
- **Manual:**
  - An AI race of 15+ minutes: the log shows one `Audio device started` after `iRacing launched` and none between callouts (baseline 2026-10-04: 16 in 18 min).
  - `Audio device stopped (idle)` follows about 5 s after iRacing exits.
  - The same exit on Mirabox: the hold is released only by app-monitor's terminated edge, and a host that delivered the launch event but never the terminate event would keep the device held, and the PC awake, until the plugin restarts.
  - Offline with iRacing closed, the Settings **Test** buttons open the device and it closes 5 s after the sound, as today.
  - Switching the Windows default output mid-race moves the audio and logs `Audio device rerouted`.
  - Changing the Output Device setting mid-race reopens on the new device at once.
  - Ask the Discord reporter to run LatencyMon on a build with this change.
