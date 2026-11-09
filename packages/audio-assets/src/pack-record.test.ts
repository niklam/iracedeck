// The guard #1667 adds to the suite: every published pack's committed record
// (`pack-records/<id>.json`) still describes the tree, so a clip, a script, a
// config label, a version or the pipeline cannot change on `master` without a
// re-pack — and, under a released version, a bump — with nothing red until a
// release is tagged (#1582, #1665). Runs offline, with no ffmpeg and no git
// history: it reads the real source tree (about 175 MB) and hashes it ONCE, in
// `checkPackRecords`, under a second on a warm checkout; the floor below walks
// the tree again but hashes nothing. The rules themselves are tested over a
// temporary tree in `src/build/pack-record.test.ts`; this file holds the REAL
// tree to them.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath } from "./build/index.mjs";
import { countSourceClips, VOICE_ROOT } from "./build/pack-format.mjs";
import { checkPackRecords, formatPackRecordProblems, packRecordPath, readPackRecord } from "./build/pack-record.mjs";
import { VOICE_PACKS } from "./build/voice-packs.mjs";

/**
 * The fewest clips a first-party voice can have. Both voices hold about 4,800
 * today; a walk that found none, or a truncated tree, fails here whatever the
 * record says. Raise it as the voices grow; never lower it to pass.
 */
const CLIP_FLOOR_PER_VOICE = 4_000;

describe("pack records — every published pack's archive is what the tree says it is", () => {
  it("has a record for every pack in VOICE_PACKS, and VOICE_PACKS has a pack to check", () => {
    // The guard is vacuous over an empty registry; today it holds two packs.
    expect(VOICE_PACKS.length).toBeGreaterThan(0);

    for (const pack of VOICE_PACKS) {
      const file = packRecordPath(pack.id);

      expect(existsSync(file), `missing ${file} — run pack:voice ${pack.id}`).toBe(true);
    }
  });

  it("holds every pack to rules 1 to 4: coverage, consistency, freshness, and a frozen released version", () => {
    // The one hash of the tree in this file: rule 3 recomputes every voice's
    // clip digest and count and compares them with the committed record's.
    const problems = checkPackRecords();

    expect(
      problems,
      `the committed pack records disagree with the tree:\n${formatPackRecordProblems(problems)}`,
    ).toEqual([]);
  });

  it("did real work: each voice's clip count on disk is the committed record's and at least the floor", () => {
    // A guard that hashed an empty tree would agree with any record it wrote
    // itself; two independent floors tie the digest to the clips that are
    // actually there — the count the COMMITTED record carries, and a fixed
    // minimum no truncated walk can reach. `countSourceClips` is the same walk
    // and the same case rules `computePackInputs` hashes with, without the
    // hashing, so this does not read the clips' bytes a second time; the rule-3
    // check above is what ties that digest to this count.
    for (const pack of VOICE_PACKS) {
      const record = readPackRecord(pack.id);

      expect(record, pack.id).not.toBeNull();

      for (const voiceId of pack.voices) {
        const clips = countSourceClips(path.join(audioAssetsPath, VOICE_ROOT, voiceId));

        expect(clips, `${pack.id}: voice "${voiceId}"`).toBe(record!.inputs.voices[voiceId]!.clips);
        expect(clips, `${pack.id}: voice "${voiceId}"`).toBeGreaterThanOrEqual(CLIP_FLOOR_PER_VOICE);
      }
    }
  });
});
