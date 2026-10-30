import { describe, expect, it } from "vitest";

import { buildEntryLookup, entryHash, type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import type { Manifest } from "./manifest.ts";
import {
  checkPauseMarks,
  describePauseMarks,
  findEntryPauseMarks,
  findPauseMarks,
  pauseMarkEntries,
  type PauseMarkEntry,
} from "./pause-marks.ts";

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

const always = () => true;

describe("findPauseMarks", () => {
  it.each([
    ["a hyphen", "left-front", ["-"]],
    ["a soft hyphen", "left­front", ["­"]],
    ["an en dash", "Change – you're behind", ["–"]],
    ["an em dash", "Change — you're behind", ["—"]],
    ["a two-em dash", "Change ⸺ you're behind", ["⸺"]],
    ["the Unicode hyphen", "left‐front", ["‐"]],
    ["a minus sign", "minus −5", ["−"]],
    ["the ellipsis character", "Stand by…", ["…"]],
    ["three periods", "Stand by...", ["..."]],
    ["two periods", "Stand by..", [".."]],
    ["a spaced ellipsis", "Stand by. . .", [". . ."]],
    ["a colon", "Left front:", [":"]],
    ["a semicolon", "Box now; tires", [";"]],
  ])("finds %s", (_label, text, expected) => {
    expect(findPauseMarks(text)).toEqual(expected);
  });

  it.each([
    ["a period pause", "Change. You're behind."],
    ["commas, apostrophes and questions", "Nice pass, that's P3! Ready?"],
    ["single-letter periods", "D. Q. Scoring's off."],
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

describe("findEntryPauseMarks", () => {
  // Conditioning text is sent too, and it has bled into the audio before (#1127).
  it("checks previous_text and next_text as well as text", () => {
    expect(
      findEntryPauseMarks({
        name: "x",
        text: "Behind",
        seed: 1,
        previous_text: "Change:",
        next_text: "car twenty-one",
      }),
    ).toEqual([":", "-"]);
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
  const currentHash = entryHash(voice.groups.tires[1], "tires", voice, buildEntryLookup(voice));

  it("reports an offender as generated while its hash matches and its clip exists", () => {
    expect(pauseMarkEntries("voice-id", voice, manifestFor({ [relPath]: currentHash }), always)).toEqual([
      { key: "tires/hyphen-01", relPath, text: "Left-front.", marks: ["-"], generated: true },
    ]);
  });

  it("reports an offender with no manifest row as not generated", () => {
    expect(pauseMarkEntries("voice-id", voice, manifestFor({}), always)[0]?.generated).toBe(false);
  });

  it("reports an offender whose config changed since it was generated as not generated", () => {
    expect(
      pauseMarkEntries("voice-id", voice, manifestFor({ [relPath]: "0000000000000000" }), always)[0]?.generated,
    ).toBe(false);
  });

  // The generator's own cache hit needs the file too, so a missing clip would
  // be refused there and must not read as grandfathered here.
  it("reports an offender whose clip is missing as not generated", () => {
    expect(
      pauseMarkEntries("voice-id", voice, manifestFor({ [relPath]: currentHash }), () => false)[0]?.generated,
    ).toBe(false);
  });
});

describe("checkPauseMarks", () => {
  const offender = (key: string, generated = true): PauseMarkEntry => ({
    key,
    relPath: `voice/voice-id/${key}.mp3`,
    text: "Left-front.",
    marks: ["-"],
    generated,
  });

  it("passes a listed offender whose clip is as generated", () => {
    expect(checkPauseMarks([offender("tires/a-01")], { tires: ["a-01"] })).toEqual({ refused: [], stale: [] });
  });

  // The positive controls for `clip-text.test.ts`.
  it("refuses an offender the list does not name — a new or copied line", () => {
    expect(checkPauseMarks([offender("tires/new-01")], { tires: ["a-01"] }).refused.map((e) => e.key)).toEqual([
      "tires/new-01",
    ]);
  });

  it("refuses an offender with no list for its voice", () => {
    expect(checkPauseMarks([offender("tires/a-01")], undefined).refused).toHaveLength(1);
  });

  it("refuses a listed offender that changed since its clip was generated", () => {
    expect(checkPauseMarks([offender("tires/a-01", false)], { tires: ["a-01"] }).refused).toHaveLength(1);
  });

  it("reports a listed entry that no longer carries a mark as stale", () => {
    expect(checkPauseMarks([], { tires: ["a-01"] }).stale).toEqual(["tires/a-01"]);
  });
});
