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
  TrafficRejoinClear,
  TrafficRejoinNear,
  TrafficRejoinOverTen,
  TrafficRejoinRightBehind,
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
 * #1113: the approaching-traffic payloads are sim-neutral verdicts. A rejoin
 * verdict names a fixed band and only `near` carries a number, with whether it
 * is the band's first call; a pit-exit verdict carries the nearest car's
 * relative arrival for logs. Pinned so a change to what the callouts read is a
 * deliberate edit here too (type test: a mismatch fails `pnpm typecheck`).
 */
describe("traffic.rejoin and traffic.pitExit", () => {
  it("carries a rejoin band, and for near its whole seconds and whether it is the first call", () => {
    expectTypeOf<SimEventMap["traffic.rejoin"]["event"]>().toEqualTypeOf<"traffic.rejoin">();
    expectTypeOf<SimEventMap["traffic.rejoin"]["data"]>().toEqualTypeOf<
      | { verdict: "rightBehind" }
      | { verdict: "near"; seconds: number; first: boolean }
      | { verdict: "overTen" }
      | { verdict: "clear" }
    >();
    expectTypeOf<SimEventMap["traffic.rejoin"]["data"]>().toEqualTypeOf<TrafficRejoin>();
    expectTypeOf<TrafficRejoin>().toEqualTypeOf<
      TrafficRejoinRightBehind | TrafficRejoinNear | TrafficRejoinOverTen | TrafficRejoinClear
    >();
    expectTypeOf<TrafficRejoin["verdict"]>().toEqualTypeOf<TrafficRejoinVerdict>();
    expectTypeOf<TrafficRejoinVerdict>().toEqualTypeOf<"rightBehind" | "near" | "overTen" | "clear">();
  });

  it("refuses a rejoin payload whose fields do not match its verdict", () => {
    // @ts-expect-error a near call always carries its seconds
    const nearWithoutSeconds: TrafficRejoin = { verdict: "near", first: true };
    // @ts-expect-error a near call always says whether it is the first
    const nearWithoutFirst: TrafficRejoin = { verdict: "near", seconds: 5 };
    // @ts-expect-error right behind speaks no number
    const rightBehindWithSeconds: TrafficRejoin = { verdict: "rightBehind", seconds: 1 };
    // @ts-expect-error over ten speaks no number
    const overTenWithSeconds: TrafficRejoin = { verdict: "overTen", seconds: 12 };
    // @ts-expect-error clear speaks no window any more
    const clearWithWindow: TrafficRejoin = { verdict: "clear", windowSeconds: 20 };
    // @ts-expect-error the old instructions are gone: the engineer never says hold
    const hold: TrafficRejoin = { verdict: "hold", seconds: 4 };
    // @ts-expect-error nor go
    const go: TrafficRejoin = { verdict: "go" };

    expectTypeOf([
      nearWithoutSeconds,
      nearWithoutFirst,
      rightBehindWithSeconds,
      overTenWithSeconds,
      clearWithWindow,
      hold,
      go,
    ]).toBeArray();
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
