import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath } from "./build/index.mjs";
import { loadVoiceConfigs } from "./generate/config.ts";
import { checkPauseMarks, describePauseMarks, loadGrandfatheredPauseMarks } from "./generate/pause-marks.ts";

// No pause marks in clip text (#1518): ElevenLabs reads a hyphen, dash,
// ellipsis, colon or semicolon as a pause and may fill it with a hesitation
// sound. The generator refuses such text; this holds every committed config to
// the same rule, so an entry that never went through the generator — a Terse
// line copied from Default with its clip and manifest row — is caught too.
// The clips that carried a mark before the rule are not changed: they are
// frozen by text in `pause-marks.grandfathered.json`, which may only shrink.

const configs = loadVoiceConfigs(path.join(audioAssetsPath, "configs"));
const grandfathered = loadGrandfatheredPauseMarks(audioAssetsPath);
const voiceIds = [...configs.keys()];

describe("clip text", () => {
  it("finds the voice configs", () => {
    expect(voiceIds.length).toBeGreaterThan(0);
  });

  it.each(voiceIds)("%s carries no pause mark outside a grandfathered, unedited entry", (voiceId) => {
    const { refused } = checkPauseMarks(voiceId, configs.get(voiceId)!, grandfathered[voiceId]);

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
});
