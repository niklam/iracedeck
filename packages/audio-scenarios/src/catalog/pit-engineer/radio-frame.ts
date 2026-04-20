/**
 * Shared walkie-talkie radio frame scenarios.
 *
 * The pit-engineer radio experience wraps every voice message with a
 * walkie-talkie tick on the SFX channel and a looped ambient pit-lane
 * background on the Ambient channel:
 *
 *   [tick-open on SFX] → [ambient start + random seek on Ambient]
 *     → (message(s) on Voice)
 *   → [ambient stop on Ambient] → [tick-close on SFX]
 *
 * These two scenarios capture the open and close halves so every catalog
 * entry can compose the frame with `@pit-engineer.radio-open` and
 * `@pit-engineer.radio-close`, keeping each scenario's focus on its own
 * message content.
 *
 * Neither scenario has a `when` — they only run when included via `@...`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

export const RADIO_OPEN: Scenario = {
  id: "pit-engineer.radio-open",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  sequence: [{ clip: "sfx/IRD-tick-open.mp3" }, { ambient: "start" }, { ambient: "seek" }],
};

export const RADIO_CLOSE: Scenario = {
  id: "pit-engineer.radio-close",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  sequence: [{ ambient: "stop" }, { clip: "sfx/IRD-tick-close.mp3" }],
};
