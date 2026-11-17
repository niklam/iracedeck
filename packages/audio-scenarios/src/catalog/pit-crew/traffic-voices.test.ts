/**
 * The first-party voices' traffic entries and clips (issue #1113, amended
 * 2026-11-11). Kept apart from `traffic.test.ts`, which tests the contracts
 * and the vocabulary against a fixture, because this file reads what the
 * voices actually script and ship: the real `callouts.json` artifacts and the
 * runtime manifest.
 *
 * Every number the detector can put on a `near` event must have its middle in
 * every first-party voice, or that call goes silent at that count (#835): the
 * close band is 2 to 9 whole seconds (`TRAFFIC_REJOIN_RIGHT_BEHIND_S` to
 * under `TRAFFIC_REJOIN_OVER_TEN_S` in `diff/traffic-rejoin.ts`, rounded
 * down), mirrored here as `TRAFFIC_NEAR_MIN_SECONDS` / `_MAX_SECONDS`.
 */
import { PUBLISHED_VOICE_IDS } from "@iracedeck/audio-assets/build";
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import shawnScript from "@iracedeck/audio-assets/voice/shawn/callouts.json" with { type: "json" };
import { type CalloutScript } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { poolMemberPattern } from "../../interpreter.js";
import { familyReferences } from "./family-references.test-util.js";
import {
  REJOIN_SECONDS_VAR,
  TRAFFIC_CLIP_SOURCES,
  TRAFFIC_GROUP,
  TRAFFIC_NEAR_MAX_SECONDS,
  TRAFFIC_NEAR_MIN_SECONDS,
  TRAFFIC_SCENARIO_IDS,
} from "./traffic.js";

const FIRST_PARTY: ReadonlyArray<{ voice: string; script: CalloutScript }> = [
  { voice: "default", script: defaultScript as CalloutScript },
  { voice: "shawn", script: shawnScript as CalloutScript },
];
const CLIPS = (manifestJson as AudioAssetsManifest).clips;

/** The approved shape (maintainer, 2026-11-11): how many takes each pool holds in a first-party voice. */
const TAKES: Record<string, number> = {
  "rejoin-intro": 8,
  "rejoin-outro": 8,
  "rejoin-update": 6,
  "rejoin-right-behind": 4,
  "rejoin-over-ten": 4,
  "rejoin-clear": 4,
  "pit-exit-traffic": 4,
  "pit-exit-clear": 4,
};

/** Two wordings of every number in the close band. */
const MIDDLE_TAKES = 2;

/** What each contract's entry speaks, in every first-party voice. */
const SEQUENCES: Record<string, readonly string[]> = {
  "pit-crew.traffic-rejoin-right-behind": ["pool:traffic/rejoin-right-behind"],
  "pit-crew.traffic-rejoin-near-first": [
    "pool:traffic/rejoin-intro",
    `{{${REJOIN_SECONDS_VAR}}}`,
    "pool:traffic/rejoin-outro",
  ],
  "pit-crew.traffic-rejoin-near-update": ["pool:traffic/rejoin-update", `{{${REJOIN_SECONDS_VAR}}}`],
  "pit-crew.traffic-rejoin-over-ten": ["pool:traffic/rejoin-over-ten"],
  "pit-crew.traffic-rejoin-clear": ["pool:traffic/rejoin-clear"],
  "pit-crew.traffic-pit-exit-traffic": ["pool:traffic/pit-exit-traffic"],
  "pit-crew.traffic-pit-exit-clear": ["pool:traffic/pit-exit-clear"],
};

function takes(voice: string, base: string): number {
  const pattern = poolMemberPattern(TRAFFIC_GROUP, base);

  return CLIPS.filter((clip) => pattern.exec(clip)?.[1] === voice).length;
}

function closeBand(): number[] {
  return Array.from(
    { length: TRAFFIC_NEAR_MAX_SECONDS - TRAFFIC_NEAR_MIN_SECONDS + 1 },
    (_, i) => TRAFFIC_NEAR_MIN_SECONDS + i,
  );
}

it("covers every published voice", () => {
  expect(FIRST_PARTY.map((v) => v.voice).sort()).toEqual([...PUBLISHED_VOICE_IDS].sort());
});

it("names a take count for every clip source", () => {
  expect(Object.keys(TAKES).sort()).toEqual(TRAFFIC_CLIP_SOURCES.map(({ base }) => base).sort());
});

describe.each(FIRST_PARTY)("voice $voice", ({ voice, script }) => {
  it("scripts every contract with a comment, a Traffic harness route and the expected sequence", () => {
    expect(Object.keys(SEQUENCES).sort()).toEqual([...TRAFFIC_SCENARIO_IDS].sort());

    for (const id of TRAFFIC_SCENARIO_IDS) {
      const entry = script.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Traffic → /);
      expect(entry.skip).toBeUndefined();
      // The contract decides the frame; the script never overrides it.
      expect(entry.frame).toBeUndefined();
      expect(entry.sequence, id).toEqual(SEQUENCES[id]);
    }
  });

  it("addresses exactly the published clip sources and references only the seconds var", () => {
    const own: CalloutScript = {
      ...script,
      scenarios: Object.fromEntries(TRAFFIC_SCENARIO_IDS.map((id) => [id, script.scenarios[id]])),
      fragments: {},
    };
    const refs = familyReferences(own);

    expect([...refs.pools].sort()).toEqual(TRAFFIC_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort());
    expect([...refs.vars]).toEqual([REJOIN_SECONDS_VAR]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
  });

  it("ships every take of each pool the script addresses", () => {
    const short = Object.entries(TAKES)
      .filter(([base, n]) => takes(voice, base) !== n)
      .map(([base, n]) => `${base}: ${takes(voice, base)} of ${n}`);

    expect(short, `traffic pools short for voice "${voice}"`).toEqual([]);
  });

  it("ships both wordings of every number in the close band", () => {
    const short = closeBand()
      .filter((n) => takes(voice, `rejoin-mid-${n}`) !== MIDDLE_TAKES)
      .map((n) => `rejoin-mid-${n}: ${takes(voice, `rejoin-mid-${n}`)} of ${MIDDLE_TAKES}`);

    expect(closeBand()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(short, `traffic middles short for voice "${voice}"`).toEqual([]);
  });

  it("ships no middle outside the close band", () => {
    const stray = CLIPS.filter((clip) => clip.startsWith(`voice/${voice}/traffic/rejoin-mid-`)).filter((clip) => {
      const n = Number(/rejoin-mid-(\d+)-\d+\.mp3$/.exec(clip)?.[1]);

      return !(n >= TRAFFIC_NEAR_MIN_SECONDS && n <= TRAFFIC_NEAR_MAX_SECONDS);
    });

    expect(stray).toEqual([]);
  });
});
