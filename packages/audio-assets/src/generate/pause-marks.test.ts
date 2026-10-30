import { describe, expect, it } from "vitest";

import { type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import {
  checkPauseMarks,
  describePauseMarks,
  findEntryPauseMarks,
  findPauseMarks,
  isGrandfathered,
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

describe("isGrandfathered", () => {
  const entry = { name: "a-01", text: "Left-front.", seed: 1 };

  it("grandfathers an entry whose text is the frozen one", () => {
    expect(isGrandfathered(entry, "Left-front.")).toBe(true);
  });

  // Grandfathering is by text, not by cache hash: a re-cut forced by a
  // dependency or a voice-wide setting leaves it in force.
  it("ignores everything but the text fields", () => {
    expect(isGrandfathered({ ...entry, seed: 7, previous_request_ids: ["x/y"] }, "Left-front.")).toBe(true);
  });

  it("does not grandfather an unlisted entry", () => {
    expect(isGrandfathered(entry, undefined)).toBe(false);
  });

  it("does not grandfather an edited text", () => {
    expect(isGrandfathered({ ...entry, text: "The left-front." }, "Left-front.")).toBe(false);
  });

  it("does not grandfather a mark added to the conditioning text", () => {
    expect(isGrandfathered({ ...entry, next_text: "right-rear" }, "Left-front.")).toBe(false);
  });
});

describe("checkPauseMarks", () => {
  const voice = buildVoiceConfig({
    tires: [
      { name: "clean-01", text: "Left front." },
      { name: "old-01", text: "Left-front." },
      { name: "new-01", text: "Right-rear." },
    ],
  });

  it("passes a voice whose every marked entry is listed with its text", () => {
    const voiceOk = buildVoiceConfig({ tires: voice.groups.tires.slice(0, 2) });

    expect(checkPauseMarks("voice-id", voiceOk, { "tires/old-01": "Left-front." })).toEqual({
      refused: [],
      stale: [],
    });
  });

  // The positive controls for `clip-text.test.ts`.
  it("refuses an entry the list does not name — a new or copied line", () => {
    expect(checkPauseMarks("voice-id", voice, { "tires/old-01": "Left-front." }).refused).toEqual([
      { key: "tires/new-01", relPath: "voice/voice-id/tires/new-01.mp3", text: "Right-rear.", marks: ["-"] },
    ]);
  });

  it("refuses every marked entry of a voice with no list", () => {
    expect(checkPauseMarks("voice-id", voice, undefined).refused.map((entry) => entry.key)).toEqual([
      "tires/old-01",
      "tires/new-01",
    ]);
  });

  it("refuses a listed entry whose text was edited and still carries a mark, and calls its listing stale", () => {
    const edited = buildVoiceConfig({ tires: [{ name: "old-01", text: "The left-front." }] });

    expect(checkPauseMarks("voice-id", edited, { "tires/old-01": "Left-front." })).toMatchObject({
      refused: [{ key: "tires/old-01" }],
      stale: ["tires/old-01"],
    });
  });

  it("calls a listing stale once its text is fixed or its entry is gone", () => {
    const fixed = buildVoiceConfig({ tires: [{ name: "old-01", text: "Left front." }] });

    expect(checkPauseMarks("voice-id", fixed, { "tires/old-01": "Left-front.", "tires/gone-01": "Gone-now." })).toEqual(
      { refused: [], stale: ["tires/old-01", "tires/gone-01"] },
    );
  });
});
