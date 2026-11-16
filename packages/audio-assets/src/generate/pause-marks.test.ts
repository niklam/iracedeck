import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import {
  APPROVED_FILE,
  checkPauseMarks,
  describePauseMarks,
  findEntryPauseMarks,
  findPauseMarks,
  GRANDFATHERED_FILE,
  isApproved,
  isGrandfathered,
  loadApprovedPauseMarks,
  loadGrandfatheredPauseMarks,
  pauseMarkStanding,
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
      staleApproved: [],
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
      { refused: [], stale: ["tires/old-01", "tires/gone-01"], staleApproved: [] },
    );
  });

  it("passes an entry the approved list holds with its text (#1643)", () => {
    expect(
      checkPauseMarks("voice-id", voice, { "tires/old-01": "Left-front." }, { "tires/new-01": "Right-rear." }),
    ).toEqual({ refused: [], stale: [], staleApproved: [] });
  });

  // The positive control for the real tree's approved-list check in `clip-text.test.ts`.
  it("refuses an approved entry whose text was edited, and calls its approval stale", () => {
    const edited = buildVoiceConfig({ tires: [{ name: "new-01", text: "The right-rear." }] });

    expect(checkPauseMarks("voice-id", edited, undefined, { "tires/new-01": "Right-rear." })).toMatchObject({
      refused: [{ key: "tires/new-01" }],
      stale: [],
      staleApproved: ["tires/new-01"],
    });
  });

  // The state the issue lead's config edit resolves: the approved take's text
  // is not yet the config's, and the config's own text carries no mark.
  it("calls an approval stale while the config still holds other, clean text", () => {
    const before = buildVoiceConfig({ "lap-time-last": [{ name: "intro-03", text: "You did a." }] });

    expect(checkPauseMarks("default", before, undefined, { "lap-time-last/intro-03": "You did a..." })).toEqual({
      refused: [],
      stale: [],
      staleApproved: ["lap-time-last/intro-03"],
    });
  });

  it("calls an approval stale once its entry is gone", () => {
    expect(
      checkPauseMarks(
        "voice-id",
        voice,
        { "tires/old-01": "Left-front." },
        {
          "tires/new-01": "Right-rear.",
          "tires/gone-01": "Gone-now.",
        },
      ).staleApproved,
    ).toEqual(["tires/gone-01"]);
  });
});

describe("isApproved", () => {
  const entry = { name: "intro-03", text: "You did a...", seed: 1 };

  it("approves an entry whose text is the approved one", () => {
    expect(isApproved(entry, "You did a...")).toBe(true);
  });

  it("ignores everything but the text fields", () => {
    expect(isApproved({ ...entry, seed: 7, previous_request_ids: ["x/y"] }, "You did a...")).toBe(true);
  });

  it("does not approve an unlisted entry", () => {
    expect(isApproved(entry, undefined)).toBe(false);
  });

  it("does not approve an edited text", () => {
    expect(isApproved({ ...entry, text: "You did a…" }, "You did a...")).toBe(false);
  });

  it("does not approve a mark added to the conditioning text", () => {
    expect(isApproved({ ...entry, previous_text: "Last lap:" }, "You did a...")).toBe(false);
  });
});

describe("pauseMarkStanding", () => {
  const marked = { name: "intro-03", text: "You did a...", seed: 1 };

  it("calls an entry with no mark clean, whatever the lists hold", () => {
    expect(pauseMarkStanding({ ...marked, text: "You did a." }, { grandfathered: undefined, approved: "x" })).toBe(
      "clean",
    );
  });

  it("calls an entry the approved list holds approved", () => {
    expect(pauseMarkStanding(marked, { grandfathered: undefined, approved: "You did a..." })).toBe("approved");
  });

  it("calls an entry the grandfathered list holds grandfathered", () => {
    expect(pauseMarkStanding(marked, { grandfathered: "You did a...", approved: undefined })).toBe("grandfathered");
  });

  // An approval is the newer, explicit decision, and is cut without the
  // grandfathered warning.
  it("prefers the approval when both lists hold the text", () => {
    expect(pauseMarkStanding(marked, { grandfathered: "You did a...", approved: "You did a..." })).toBe("approved");
  });

  it("refuses an entry neither list holds with its text", () => {
    expect(pauseMarkStanding(marked, { grandfathered: "You did a..", approved: "You did a.." })).toBe("refused");
    expect(pauseMarkStanding(marked, { grandfathered: undefined, approved: undefined })).toBe("refused");
  });
});

describe("loading the lists", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pause-marks-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["grandfathered", GRANDFATHERED_FILE, loadGrandfatheredPauseMarks],
    ["approved", APPROVED_FILE, loadApprovedPauseMarks],
  ])("reads the %s list from its own file", (_label, file, load) => {
    const list = { default: { "lap-time-last/intro-03": "You did a..." } };

    fs.writeFileSync(path.join(root, file), JSON.stringify(list));

    expect(load(root)).toEqual(list);
  });

  it("refuses a malformed list, naming the file and the bad key", () => {
    fs.writeFileSync(path.join(root, APPROVED_FILE), JSON.stringify({ default: { "lap-time-last/intro-03": 3 } }));

    expect(() => loadApprovedPauseMarks(root)).toThrow(
      'pause-marks.approved.json must map each voice id to "<group>/<name>" → text: default["lap-time-last/intro-03"]: ',
    );
  });

  it("does not read the approved list from the grandfathered file", () => {
    fs.writeFileSync(path.join(root, GRANDFATHERED_FILE), JSON.stringify({ default: {} }));

    expect(() => loadApprovedPauseMarks(root)).toThrow(/ENOENT/);
  });
});
