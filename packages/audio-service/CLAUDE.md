# @iracedeck/audio-service

The TypeScript mixer singleton over `@iracedeck/audio-native` (`AudioChannel`, `AudioBus`, `initializeAudio`, `getAudio`): bus routing, volumes, the voice-sequence engine and device selection.

## Channels and buses

`AudioChannel` is a copy of `@iracedeck/audio-native`'s enum, held to it by a type-level check in `audio-service.test.ts`. Every per-channel table and all-channels loop is sized from the enum, so a new channel is an entry in both enums plus a bump of the native `IRD_MAX_CHANNELS`, and it gets the native end callback the idle release below depends on without further code. Each channel routes to one bus in `CHANNEL_BUS_MAP` and follows `setBusVolume`, except `Feedback` (#1455, the volume step tick, and since #269 the press sounds' single and double bleep, which `iracing-actions`' `playPressSound` plays there at the tick's level rule), whose entry is an explicit `null`: no bus volume touches it, and `playOnChannelAtLevel(channel, filePath, level)` plays a clip on it at a 0–1 level through the same perceptual curve as the bus setters, for that play only. That method refuses a channel routed to a bus, whose bus volume would overwrite the level mid-play.

## Device lifecycle

The device opens on demand and the stream stops after an idle window, so an open stream never blocks PC sleep (#849). `hold(reason)` / `release(reason)` keep it open instead; `iracing-actions`' audio session hold takes one while iRacing runs (#1347).

## Clip resolution

Clips resolve against ordered audio roots. Since #1144 a pack root is bound to its own voices: `voice/<pack>::<voice>/…` is served only by that pack, and the ordered walk (which serves the sfx) never reaches a bound root.

## The test fake

`@iracedeck/audio-service/testing` (`src/testing.ts`, #1504) is for tests only: it imports `vitest`, and the root guard `scripts/testing-entries-test-only.test.mjs` fails on any production source in `packages/` that imports it (#1375). Its `createFakeAudio()` is the one fake of `IAudioService`, used by every Race Engineer test that hands the engine an audio service (`audio-scenarios`, `scenario-harness`): each member is a `vi.fn`, and its type is a mapped type over the interface, so a member added to the service fails to compile there, once, until the fake implements it. Plays and stops are recorded (`_played`, `_stopped`), a clip ends only when a test calls `_triggerChannelEnd(channel)`, and `_reset()` clears both. A test that needs more sets it on the one member through the mock (`mockReturnValue`, `mockImplementation`), never on the shared fake; to extend a default rather than replace it, keep `getMockImplementation()` and call it from the override, as the clocked fakes do.
