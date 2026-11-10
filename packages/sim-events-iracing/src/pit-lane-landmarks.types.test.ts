/**
 * The pit-lane landmark types exist twice (issue #1112): `@iracedeck/event-bus`
 * declares the `pitLane.landmarkLearned` payload inline so the catalog stays a
 * leaf, and `@iracedeck/track-data` declares the model the translator and the
 * store fold with. This package is the one that imports both — it builds the
 * payload from track-data's types and publishes it as event-bus's — so it pins
 * them identical, both ways: a field added, dropped or retyped on either side
 * fails the typecheck here.
 */
import type * as Bus from "@iracedeck/event-bus";
import type * as TrackData from "@iracedeck/track-data";
import { describe, expectTypeOf, it } from "vitest";

describe("pit-lane landmark types match across event-bus and track-data (issue #1112)", () => {
  it("PitLaneLandmarkName", () => {
    expectTypeOf<TrackData.PitLaneLandmarkName>().toEqualTypeOf<Bus.PitLaneLandmarkName>();
    expectTypeOf<Bus.PitLaneLandmarkName>().toEqualTypeOf<TrackData.PitLaneLandmarkName>();
  });

  it("PitLaneTrackIdentity", () => {
    expectTypeOf<TrackData.PitLaneTrackIdentity>().toEqualTypeOf<Bus.PitLaneTrackIdentity>();
    expectTypeOf<Bus.PitLaneTrackIdentity>().toEqualTypeOf<TrackData.PitLaneTrackIdentity>();
  });

  it("PitLaneLandmarkSample", () => {
    expectTypeOf<TrackData.PitLaneLandmarkSample>().toEqualTypeOf<Bus.PitLaneLandmarkSample>();
    expectTypeOf<Bus.PitLaneLandmarkSample>().toEqualTypeOf<TrackData.PitLaneLandmarkSample>();
  });

  it("PitLaneLandmarkSummary", () => {
    expectTypeOf<TrackData.PitLaneLandmarkSummary>().toEqualTypeOf<Bus.PitLaneLandmarkSummary>();
    expectTypeOf<Bus.PitLaneLandmarkSummary>().toEqualTypeOf<TrackData.PitLaneLandmarkSummary>();
  });

  it("the event payload is exactly the four, in track-data's terms", () => {
    expectTypeOf<Bus.PitLaneLandmarkLearned>().toEqualTypeOf<{
      track: TrackData.PitLaneTrackIdentity;
      landmark: TrackData.PitLaneLandmarkName;
      sample: TrackData.PitLaneLandmarkSample;
      summary: TrackData.PitLaneLandmarkSummary;
    }>();
  });

  it("the names list is the union", () => {
    expectTypeOf<(typeof TrackData.PIT_LANE_LANDMARK_NAMES)[number]>().toEqualTypeOf<Bus.PitLaneLandmarkName>();
  });
});
