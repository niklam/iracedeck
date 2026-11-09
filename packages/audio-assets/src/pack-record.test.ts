// The guard #1667 adds to the suite: every published pack's committed record
// (`pack-records/<id>.json`) still describes the tree, so a clip, a script, a
// config label, a version or the pipeline cannot change on `master` without a
// re-pack — and, under a released version, a bump — with nothing red until a
// release is tagged (#1582, #1665). Runs offline, with no ffmpeg and no git
// history: it reads the real source tree (about 175 MB) and hashes it, under a
// second on a warm checkout. The rules themselves are tested over a temporary
// tree in `src/build/pack-record.test.ts`; this file holds the REAL tree to them.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath } from "./build/index.mjs";
import { countSourceClips } from "./build/pack-format.mjs";
import { checkPackRecords, computePackInputs, formatPackRecordProblems } from "./build/pack-record.mjs";
import { VOICE_PACKS } from "./build/voice-packs.mjs";

describe("pack records — every published pack's archive is what the tree says it is", () => {
  it("has a record for every pack in VOICE_PACKS, and VOICE_PACKS has a pack to check", () => {
    // The guard is vacuous over an empty registry; today it holds two packs.
    expect(VOICE_PACKS.length).toBeGreaterThan(0);
  });

  it("holds every pack to rules 1 to 4: coverage, consistency, freshness, and a frozen released version", () => {
    const problems = checkPackRecords();

    expect(
      problems,
      `the committed pack records disagree with the tree:\n${formatPackRecordProblems(problems)}`,
    ).toEqual([]);
  });

  it("did real work: each voice's recomputed clip count is countSourceClips' and above zero", () => {
    // A guard that hashed an empty tree would agree with any record; the count
    // ties the digest to the clips that are actually there.
    for (const pack of VOICE_PACKS) {
      const inputs = computePackInputs(pack);

      for (const voiceId of pack.voices) {
        const clips = inputs.voices[voiceId]!.clips;

        expect(clips, `${pack.id}: voice "${voiceId}"`).toBe(
          countSourceClips(path.join(audioAssetsPath, "voice", voiceId)),
        );
        expect(clips, `${pack.id}: voice "${voiceId}"`).toBeGreaterThan(0);
      }
    }
  });
});
