import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath } from "./build/index.mjs";
import { loadVoiceConfigs } from "./generate/config.ts";
import { loadManifest } from "./generate/manifest.ts";
import {
  checkPauseMarks,
  describePauseMarks,
  type GrandfatheredPauseMarks,
  pauseMarkEntries,
} from "./generate/pause-marks.ts";

// No pause marks in clip text (#1518): ElevenLabs reads a hyphen, dash,
// ellipsis, colon or semicolon as a pause and may fill it with a hesitation
// sound. The generator refuses such text; this holds every committed config to
// the same rule, so an entry that never went through the generator — a Terse
// line copied from Default with its clip and manifest row — is caught too.
// The clips that carried a mark before the rule are not changed: they are
// listed in `pause-marks.grandfathered.json`, which may only shrink.

const configs = loadVoiceConfigs(path.join(audioAssetsPath, "configs"));
const manifest = loadManifest(path.join(audioAssetsPath, "generate.manifest.json"));
const grandfathered = JSON.parse(
  readFileSync(path.join(audioAssetsPath, "pause-marks.grandfathered.json"), "utf-8"),
) as GrandfatheredPauseMarks;
const clipExists = (relPath: string) => existsSync(path.join(audioAssetsPath, relPath));

describe("clip text", () => {
  it("finds the voice configs", () => {
    expect(configs.size).toBeGreaterThan(0);
  });

  it.each([...configs.keys()])("%s carries no pause mark outside a grandfathered, unchanged clip", (voiceId) => {
    const { refused } = checkPauseMarks(
      pauseMarkEntries(voiceId, configs.get(voiceId)!, manifest, clipExists),
      grandfathered[voiceId],
    );

    expect(
      refused.map((entry) => `${entry.relPath} ${JSON.stringify(entry.text)}: ${describePauseMarks(entry.marks)}`),
    ).toEqual([]);
  });

  // The list only shrinks: an entry whose text was fixed (or that was removed)
  // comes off it, so it can never grandfather a new line under an old name.
  it.each([...configs.keys()])("%s lists no grandfathered entry that no longer carries a mark", (voiceId) => {
    const { stale } = checkPauseMarks(
      pauseMarkEntries(voiceId, configs.get(voiceId)!, manifest, clipExists),
      grandfathered[voiceId],
    );

    expect(stale).toEqual([]);
  });

  it("lists only voices that have a config", () => {
    expect(Object.keys(grandfathered).filter((voiceId) => !configs.has(voiceId))).toEqual([]);
  });
});
