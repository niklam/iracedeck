import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath } from "./build/index.mjs";
import { buildEntryLookup, loadVoiceConfigs, type VoiceConfig } from "./generate/config.ts";
import {
  checkPauseMarks,
  describePauseMarks,
  findPauseMarks,
  loadApprovedPauseMarks,
  loadGrandfatheredPauseMarks,
} from "./generate/pause-marks.ts";

// No pause marks in clip text (#1518): ElevenLabs reads a hyphen, dash,
// ellipsis, colon or semicolon as a pause and may fill it with a hesitation
// sound. The generator refuses such text; this holds every committed config to
// the same rule, so an entry that never went through the generator — a Terse
// line copied from Default with its clip and manifest row — is caught too.
// The clips that carried a mark before the rule are not changed: they are
// frozen by text in `pause-marks.grandfathered.json`, which may only shrink.
// A newer line may carry a mark only once Niklas has heard its take and
// approved it: `pause-marks.approved.json` holds each such approval by text
// (#1643). It grows one approval at a time, so its size is not pinned here.

const configs = loadVoiceConfigs(path.join(audioAssetsPath, "configs"));
const grandfathered = loadGrandfatheredPauseMarks(audioAssetsPath);
const approved = loadApprovedPauseMarks(audioAssetsPath);
const voiceIds = [...configs.keys()];

// The size of each voice's grandfathered list when the rule landed (#1518). Only ever lowered.
const GRANDFATHERED_COUNTS: Record<string, number> = { default: 850, shawn: 853 };

/** `voice` with each listed entry's text set to the listed one, as if the config already held it. */
function withListedText(voice: VoiceConfig, listed: Record<string, string>): VoiceConfig {
  return {
    ...voice,
    groups: Object.fromEntries(
      Object.entries(voice.groups).map(([groupName, entries]) => [
        groupName,
        entries.map((entry) => {
          const text = listed[`${groupName}/${entry.name}`];

          return text === undefined ? entry : { ...entry, text };
        }),
      ]),
    ),
  };
}

describe("clip text", () => {
  it("finds the voice configs", () => {
    expect(voiceIds.length).toBeGreaterThan(0);
  });

  it.each(voiceIds)("%s carries no pause mark outside a grandfathered or approved, unedited entry", (voiceId) => {
    const { refused } = checkPauseMarks(voiceId, configs.get(voiceId)!, grandfathered[voiceId], approved[voiceId]);

    expect(
      refused.map((entry) => `${entry.relPath} ${JSON.stringify(entry.text)}: ${describePauseMarks(entry.marks)}`),
    ).toEqual([]);
  });

  // The list only shrinks: an entry whose text was fixed (or that was removed)
  // comes off it, so it can never grandfather a new line under an old name.
  it.each(voiceIds)("%s lists no grandfathered entry whose text has changed or gone", (voiceId) => {
    expect(checkPauseMarks(voiceId, configs.get(voiceId)!, grandfathered[voiceId]).stale).toEqual([]);
  });

  it("lists only voices that have a config", () => {
    expect(Object.keys(grandfathered).filter((voiceId) => !configs.has(voiceId))).toEqual([]);
  });

  // Nothing above stops a new marked line arriving WITH its text added to the
  // list, so the size of each voice's list is frozen here too. When an entry
  // comes off the list, lower its voice's number in the same change. Never raise
  // one: a line written after #1518 is never grandfathered.
  it("holds each voice's list to its frozen size", () => {
    expect(
      Object.fromEntries(
        Object.entries(grandfathered).map(([voiceId, entries]) => [voiceId, Object.keys(entries).length]),
      ),
    ).toEqual(GRANDFATHERED_COUNTS);
  });
});

describe("approved pause marks (#1643)", () => {
  const approvedVoiceIds = Object.keys(approved);

  it("approves only for voices that have a config", () => {
    expect(approvedVoiceIds.filter((voiceId) => !configs.has(voiceId))).toEqual([]);
  });

  it("names only entries that exist", () => {
    const missing = approvedVoiceIds.flatMap((voiceId) => {
      const voice = configs.get(voiceId);
      const lookup = voice === undefined ? new Map<string, unknown>() : buildEntryLookup(voice);

      return Object.keys(approved[voiceId]!)
        .filter((key) => !lookup.has(key))
        .map((key) => `${voiceId}/${key}`);
    });

    expect(missing).toEqual([]);
  });

  // An approval of text with no mark in it exempts nothing, so it is a slip:
  // most likely the approved text was copied without its mark.
  it("approves only text that carries a pause mark", () => {
    const clean = approvedVoiceIds.flatMap((voiceId) =>
      Object.entries(approved[voiceId]!)
        .filter(([, text]) => findPauseMarks(text).length === 0)
        .map(([key]) => `${voiceId}/${key}`),
    );

    expect(clean).toEqual([]);
  });

  // Whether or not the config holds the approved text yet: the list lets each
  // of its own entries through, and it is the list that does.
  it("lets each approved entry through with its approved text, and only through the list", () => {
    for (const voiceId of approvedVoiceIds.filter((id) => configs.has(id))) {
      const voice = withListedText(configs.get(voiceId)!, approved[voiceId]!);
      const keys = Object.keys(approved[voiceId]!);
      const refusedKeys = (list: Record<string, string> | undefined): string[] =>
        checkPauseMarks(voiceId, voice, grandfathered[voiceId], list).refused.map((entry) => entry.key);

      expect(refusedKeys(approved[voiceId])).toEqual([]);
      expect(refusedKeys(undefined)).toEqual(expect.arrayContaining(keys));
    }
  });

  // An edit voids an approval: the take Niklas heard was cut from the listed
  // text, so a listing whose text the config no longer holds comes off.
  it.each(voiceIds)("%s approves no entry whose text has changed or gone", (voiceId) => {
    expect(
      checkPauseMarks(voiceId, configs.get(voiceId)!, grandfathered[voiceId], approved[voiceId]).staleApproved,
    ).toEqual([]);
  });
});
