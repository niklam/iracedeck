# @iracedeck/audio-service

The TypeScript mixer singleton over `@iracedeck/audio-native` (`AudioChannel`, `AudioBus`, `initializeAudio`, `getAudio`): bus routing, volumes, the voice-sequence engine and device selection.

## Channels and buses

`AudioChannel` is a copy of `@iracedeck/audio-native`'s enum, held to it by a type-level check in `audio-service.test.ts`. Every per-channel table and all-channels loop is sized from the enum, so a new channel is an entry in both enums plus a bump of the native `IRD_MAX_CHANNELS`, and it gets the native end callback the idle release below depends on without further code. Each channel routes to one bus in `CHANNEL_BUS_MAP` and follows `setBusVolume`, except `Feedback` (#1455, the volume step tick, and since #269 the press sounds' click and bleep, which `iracing-actions`' `playPressSound` plays there at the tick's level rule), whose entry is an explicit `null`: no bus volume touches it, and `playOnChannelAtLevel(channel, filePath, level)` plays a clip on it at a 0–1 level through the same perceptual curve as the bus setters, for that play only. That method refuses a channel routed to a bus, whose bus volume would overwrite the level mid-play.

## Device lifecycle

The device opens on demand and the stream stops after an idle window, so an open stream never blocks PC sleep (#849). `hold(reason)` / `release(reason)` keep it open instead; `iracing-actions`' audio session hold takes one while iRacing runs (#1347).

## Clip resolution

Clips resolve against ordered audio roots. Since #1144 a pack root is bound to its own voices: `voice/<pack>::<voice>/…` is served only by that pack, and the ordered walk (which serves the sfx) never reaches a bound root.
