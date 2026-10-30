import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PRESS_SOUND_CLIPS } from "./press-sounds.js";

/**
 * The press sound clips (#269) the player names are real files in
 * `@iracedeck/audio-assets`, whose `sfx/` is copied into the plugins
 * unchanged. A missing or misnamed clip would leave every press silent with
 * only a failed-play log line, so the path and the format are pinned here: a
 * plain mono 48 kHz 16-bit PCM WAV with no metadata chunks, which is what the
 * player's mixer expects and what keeps the bleep free of an MP3's encoder
 * delay.
 */
const AUDIO_ASSETS = join(import.meta.dirname, "../../../audio-assets");

describe("press sound clips (#269)", () => {
  it.each(Object.entries(PRESS_SOUND_CLIPS))("the %s clip %s is a mono 48 kHz 16-bit PCM WAV", (_sound, clip) => {
    const wav = readFileSync(join(AUDIO_ASSETS, clip));

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.length - 44).toBeGreaterThan(0);
  });

  it("names two different files", () => {
    expect(new Set(Object.values(PRESS_SOUND_CLIPS)).size).toBe(Object.keys(PRESS_SOUND_CLIPS).length);
  });
});
