/**
 * The forum profiles (#1460): what each forum is, and that the
 * feature-requests profile is exactly #1114's behaviour.
 */
import { describe, expect, it } from "vitest";

import {
  bugShouldPropose,
  bugTag,
  featureRequestShouldPropose,
  featureRequestTag,
  STATUS_TAGS,
} from "./discord-forum.mjs";
import { DEFAULT_FORUM, forumProfile, FORUMS } from "./discord-forums.mjs";

describe("FORUMS", () => {
  it("defaults to feature-requests, so every #1114 invocation keeps working", () => {
    expect(DEFAULT_FORUM).toBe("feature-requests");
    expect(Object.keys(FORUMS)).toEqual(["feature-requests", "bugs"]);
  });

  it("gives feature-requests its channel, its five tags and #1114's mapping", () => {
    expect(FORUMS["feature-requests"]).toMatchObject({
      name: "feature-requests",
      label: "feature-requests forum",
      channelEnv: "DISCORD_FEATURE_REQUESTS_CHANNEL_ID",
      statusTags: STATUS_TAGS,
      sourceVerb: "Requested",
      releasedTag: "Released",
      expectedTag: featureRequestTag,
      shouldPropose: featureRequestShouldPropose,
    });
  });

  it("gives bugs its channel, the one Resolved tag and the bug mapping", () => {
    expect(FORUMS.bugs).toMatchObject({
      name: "bugs",
      label: "bugs forum",
      channelEnv: "DISCORD_BUGS_CHANNEL_ID",
      statusTags: ["Resolved"],
      sourceVerb: "Reported",
      releasedTag: "Resolved",
      expectedTag: bugTag,
      shouldPropose: bugShouldPropose,
    });
  });

  it("is frozen, profiles included", () => {
    expect(Object.isFrozen(FORUMS)).toBe(true);
    expect(Object.isFrozen(FORUMS.bugs)).toBe(true);
    expect(Object.isFrozen(FORUMS.bugs.statusTags)).toBe(true);
  });
});

describe("noTagNote", () => {
  const closed = (stateReason) => ({ state: "CLOSED", stateReason });

  it("explains only a duplicate in feature-requests, the one state with no tag there", () => {
    expect(FORUMS["feature-requests"].noTagNote(closed("DUPLICATE"))).toBe(
      "closed as duplicate; point the post at the canonical issue by hand",
    );
    expect(FORUMS["feature-requests"].noTagNote({ state: "OPEN", stateReason: null })).toBeNull();
  });

  it("says nothing for an open bug, and names the hand step for the closed ones", () => {
    const { noTagNote } = FORUMS.bugs;

    expect(noTagNote({ state: "OPEN", stateReason: null })).toBeNull();
    expect(noTagNote(closed("NOT_PLANNED"))).toBe("closed as not planned; reply by hand");
    expect(noTagNote(closed("DUPLICATE"))).toBe("closed as duplicate; reply by hand with the canonical issue");
    expect(noTagNote(closed("COMPLETED"))).toBe("fixed, but not in a stable release yet");
  });
});

describe("forumProfile", () => {
  it("returns the named profile", () => {
    expect(forumProfile("bugs")).toBe(FORUMS.bugs);
    expect(forumProfile("feature-requests")).toBe(FORUMS["feature-requests"]);
  });

  it("throws on an unknown name, listing the valid ones", () => {
    expect(() => forumProfile("nope")).toThrow('Unknown forum "nope". Valid: feature-requests, bugs');
    // An inherited property is not a forum.
    expect(() => forumProfile("toString")).toThrow(/Unknown forum "toString"/);
  });
});
