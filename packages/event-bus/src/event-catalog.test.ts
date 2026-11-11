import { describe, expectTypeOf, it } from "vitest";

import type {
  PitLaneLandmarkLearned,
  PitLaneLandmarkName,
  PitLaneLandmarkSample,
  PitLaneLandmarkSummary,
  PitLaneTrackIdentity,
  QualifyingInvalidationSnapshot,
  SessionCategory,
  SessionClass,
  SessionStartConditions,
  SimEventMap,
  TrafficPitExit,
  TrafficPitExitVerdict,
  TrafficRejoin,
  TrafficRejoinVerdict,
} from "./index.js";

/**
 * #1587 named the practice / qualifying / race union `SessionCategory`. The
 * three payload fields that spelled it inline must keep exactly the type they
 * had, so a published shape cannot drift through the alias (type test: a
 * mismatch fails `pnpm typecheck`).
 */
describe("SessionCategory", () => {
  it("is the same union the session-typed payloads always carried", () => {
    expectTypeOf<SessionCategory>().toEqualTypeOf<"practice" | "qualifying" | "race">();
    expectTypeOf<SessionStartConditions["sessionType"]>().toEqualTypeOf<"practice" | "qualifying" | "race">();
    expectTypeOf<QualifyingInvalidationSnapshot["sessionType"]>().toEqualTypeOf<
      "practice" | "qualifying" | "race" | undefined
    >();
    expectTypeOf<SimEventMap["lap.completed"]["data"]["sessionType"]>().toEqualTypeOf<
      "practice" | "qualifying" | "race" | undefined
    >();
  });

  it("is what a classified session carries, beside the solo-qualifying flag", () => {
    expectTypeOf<SessionClass>().toEqualTypeOf<{
      readonly category: "practice" | "qualifying" | "race";
      readonly soloQualifying: boolean;
    }>();
  });
});

/**
 * #1112: the catalog declares the landmark payload inline, beside
 * `@iracedeck/track-data`'s model types it must match, because the catalog
 * imports nothing. This pins the catalog's side field by field, so changing
 * the published shape is a deliberate edit here too (type test: a mismatch
 * fails `pnpm typecheck`). The two copies are pinned to each other by a
 * two-way equality test in `@iracedeck/sim-events-iracing`, which depends on
 * both; this package cannot see track-data.
 */
describe("pitLane.landmarkLearned", () => {
  it("carries the track, the landmark, the accepted sample and the summary", () => {
    expectTypeOf<SimEventMap["pitLane.landmarkLearned"]["event"]>().toEqualTypeOf<"pitLane.landmarkLearned">();
    expectTypeOf<SimEventMap["pitLane.landmarkLearned"]["data"]>().toEqualTypeOf<{
      track: {
        sim: string;
        trackId: number;
        trackName: string;
        trackConfigName: string;
        trackVersion: string | null;
        trackLength: string;
        trackLengthM: number | null;
      };
      landmark: "approachStart" | "pitRoadStart" | "pitRoadEnd" | "blendEnd";
      sample: { pct: number; estTime: number; carClassId: number; key: string; at: number };
      summary: { pct: number; estTimeByClass: Record<string, number>; samples: number; published: boolean };
    }>();
  });

  it("names its parts with the catalog's own types", () => {
    type Data = SimEventMap["pitLane.landmarkLearned"]["data"];
    expectTypeOf<Data>().toEqualTypeOf<PitLaneLandmarkLearned>();
    expectTypeOf<Data["track"]>().toEqualTypeOf<PitLaneTrackIdentity>();
    expectTypeOf<Data["landmark"]>().toEqualTypeOf<PitLaneLandmarkName>();
    expectTypeOf<Data["sample"]>().toEqualTypeOf<PitLaneLandmarkSample>();
    expectTypeOf<Data["summary"]>().toEqualTypeOf<PitLaneLandmarkSummary>();
  });
});

/**
 * #1113: the approaching-traffic payloads are sim-neutral verdicts with an
 * optional number of seconds. Pinned so a change to what the callouts read is
 * a deliberate edit here too (type test: a mismatch fails `pnpm typecheck`).
 */
describe("traffic.rejoin and traffic.pitExit", () => {
  it("carries a rejoin verdict and, except for go, its seconds", () => {
    expectTypeOf<SimEventMap["traffic.rejoin"]["event"]>().toEqualTypeOf<"traffic.rejoin">();
    expectTypeOf<SimEventMap["traffic.rejoin"]["data"]>().toEqualTypeOf<{
      verdict: "clear" | "notice" | "hold" | "go";
      seconds?: number;
    }>();
    expectTypeOf<SimEventMap["traffic.rejoin"]["data"]>().toEqualTypeOf<TrafficRejoin>();
    expectTypeOf<TrafficRejoin["verdict"]>().toEqualTypeOf<TrafficRejoinVerdict>();
  });

  it("carries a pit-exit verdict and the nearest car's relative arrival", () => {
    expectTypeOf<SimEventMap["traffic.pitExit"]["event"]>().toEqualTypeOf<"traffic.pitExit">();
    expectTypeOf<SimEventMap["traffic.pitExit"]["data"]>().toEqualTypeOf<{
      verdict: "clear" | "traffic";
      seconds?: number;
    }>();
    expectTypeOf<SimEventMap["traffic.pitExit"]["data"]>().toEqualTypeOf<TrafficPitExit>();
    expectTypeOf<TrafficPitExit["verdict"]>().toEqualTypeOf<TrafficPitExitVerdict>();
  });
});
