# @iracedeck/audio-service

The TypeScript mixer singleton over `@iracedeck/audio-native` (`AudioChannel`, `AudioBus`, `initializeAudio`, `getAudio`): bus routing, volumes, the voice-sequence engine and device selection.

## Device lifecycle

The device opens on demand and the stream stops after an idle window, so an open stream never blocks PC sleep (#849). `hold(reason)` / `release(reason)` keep it open instead; `iracing-actions`' audio session hold takes one while iRacing runs (#1347).

## Clip resolution

Clips resolve against ordered audio roots. Since #1144 a pack root is bound to its own voices: `voice/<pack>::<voice>/…` is served only by that pack, and the ordered walk (which serves the sfx) never reaches a bound root.
