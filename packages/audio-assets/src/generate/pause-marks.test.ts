import { describe, expect, it } from "vitest";

import { buildEntryLookup, entryHash, type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import type { Manifest } from "./manifest.ts";
import { describePauseMarks, findPauseMarks, pauseMarkEntries } from "./pause-marks.ts";

function buildVoiceConfig(groups: Record<string, Array<Record<string, unknown>>>): VoiceConfig {
  return VoiceConfigSchema.parse({
    id: "voice-id",
    label: "Test",
    model_id: "eleven_test_model",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups,
  });
}

function manifestFor(entries: Record<string, string>): Manifest {
  return {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(entries).map(([relPath, hash]) => [
        relPath,
        { hash, voiceId: "voice-id", model: "eleven_test_model", textPreview: "", generatedAt: "" },
      ]),
    ),
  };
}

describe("findPauseMarks", () => {
  it.each([
    ["a hyphen", "left-front", ["-"]],
    ["an en dash", "Change – you're behind", ["–"]],
    ["an em dash", "Change — you're behind", ["—"]],
    ["the Unicode hyphen", "left‐front", ["‐"]],
    ["a minus sign", "minus −5", ["−"]],
    ["the ellipsis character", "Stand by…", ["…"]],
    ["three periods", "Stand by...", ["..."]],
    ["two periods", "Stand by..", [".."]],
    ["a colon", "Left front:", [":"]],
    ["a semicolon", "Box now; tires", [";"]],
  ])("finds %s", (_label, text, expected) => {
    expect(findPauseMarks(text)).toEqual(expected);
  });

  it.each([
    ["a period pause", "Change. You're behind."],
    ["commas, apostrophes and questions", "Nice pass, that's P3! Ready?"],
    ["an SSML break tag", 'D Q. <break time="0.3s" /> Scoring\'s off.'],
    ["an SSML break tag without a space", 'Nice pass! <break time="0.3s"/> Third.'],
  ])("passes %s", (_label, text) => {
    expect(findPauseMarks(text)).toEqual([]);
  });

  it("still sees a mark next to a break tag", () => {
    expect(findPauseMarks('D-Q. <break time="0.3s" /> Scoring\'s off.')).toEqual(["-"]);
  });

  it("names each mark once in the message", () => {
    expect(describePauseMarks(["-", "-", ":"])).toMatch(/pause marks "-", ":": .*period.*#1518/);
  });
});

describe("pauseMarkEntries", () => {
  const voice = buildVoiceConfig({
    tires: [
      { name: "clean-01", text: "Left front." },
      { name: "hyphen-01", text: "Left-front." },
    ],
  });
  const relPath = "voice/voice-id/tires/hyphen-01.mp3";
  const hyphenEntry = voice.groups.tires[1];
  const currentHash = entryHash(hyphenEntry, "tires", voice, buildEntryLookup(voice));

  it("grandfathers an entry only while its manifest hash matches", () => {
    expect(pauseMarkEntries("voice-id", voice, manifestFor({ [relPath]: currentHash }))).toEqual([
      { relPath, text: "Left-front.", marks: ["-"], generated: true },
    ]);
  });

  // The positive controls for `clip-text.test.ts`: an entry never generated,
  // and one whose config changed since its clip was cut, are both refused.
  it("does not grandfather an entry with no manifest row", () => {
    expect(pauseMarkEntries("voice-id", voice, manifestFor({}))).toEqual([
      { relPath, text: "Left-front.", marks: ["-"], generated: false },
    ]);
  });

  it("does not grandfather an entry whose config changed since it was generated", () => {
    expect(pauseMarkEntries("voice-id", voice, manifestFor({ [relPath]: "0000000000000000" }))[0]?.generated).toBe(
      false,
    );
  });
});
