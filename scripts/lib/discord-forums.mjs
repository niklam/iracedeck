/**
 * The forum profiles of the Discord tooling (#1460). The feature-requests and
 * #bugs forums differ only in data — the channel, the status tags a post can
 * carry, the source line's verb, and which tag an issue's state maps to — so
 * every command takes a profile rather than each forum getting a sibling
 * script. A third forum is a third entry here.
 *
 * This module imports the pure mappings from `discord-forum.mjs`; that file
 * never imports this one.
 *
 * Design record: docs/superpowers/specs/2026-10-18-issue-1460-discord-bugs-forum.md
 */
import {
  BUG_STATUS_TAGS,
  bugShouldPropose,
  bugTag,
  featureRequestShouldPropose,
  featureRequestTag,
  RESOLVED,
  STATUS_TAGS,
} from "./discord-forum.mjs";

export const DEFAULT_FORUM = "feature-requests";

/**
 * Each profile:
 * - `label` names the forum in messages ("… is not a post in the bugs forum.");
 * - `channelEnv` is the variable holding its channel id;
 * - `statusTags` are the moderated tags this tool may set, in order;
 * - `sourceVerb` opens the source line an issue carries back to its post;
 * - `releasedTag` is the tag a shipped issue earns, named in the follow-up's
 *   "must be set by hand" note;
 * - `expectedTag(issue, releasedVersion)` and `shouldPropose(current, expected)`
 *   are the follow-up mapping and ranking;
 * - `noTagNote(issue, releasedVersion)` explains an `expectedTag` of `null`
 *   when that needs explaining, and is `null` when it is the normal answer.
 */
export const FORUMS = Object.freeze({
  "feature-requests": Object.freeze({
    name: "feature-requests",
    label: "feature-requests forum",
    channelEnv: "DISCORD_FEATURE_REQUESTS_CHANNEL_ID",
    statusTags: STATUS_TAGS,
    sourceVerb: "Requested",
    releasedTag: "Released",
    expectedTag: featureRequestTag,
    shouldPropose: featureRequestShouldPropose,
    // The only state with no feature-requests tag is a duplicate.
    noTagNote: (issue) =>
      issue.stateReason === "DUPLICATE" ? "closed as duplicate; point the post at the canonical issue by hand" : null,
  }),
  bugs: Object.freeze({
    name: "bugs",
    label: "bugs forum",
    channelEnv: "DISCORD_BUGS_CHANNEL_ID",
    statusTags: BUG_STATUS_TAGS,
    sourceVerb: "Reported",
    releasedTag: RESOLVED,
    expectedTag: bugTag,
    shouldPropose: bugShouldPropose,
    // An open bug carrying no tag is the normal case, so it gets no note.
    noTagNote: (issue) => {
      if (issue.state !== "CLOSED") return null;
      if (issue.stateReason === "NOT_PLANNED") return "closed as not planned; reply by hand";
      if (issue.stateReason === "DUPLICATE") return "closed as duplicate; reply by hand with the canonical issue";

      return "fixed, but not in a stable release yet";
    },
  }),
});

/** @returns the profile named `name`; throws, listing the valid names, on any other. */
export function forumProfile(name) {
  if (!Object.hasOwn(FORUMS, name)) {
    throw new Error(`Unknown forum "${name}". Valid: ${Object.keys(FORUMS).join(", ")}`);
  }

  return FORUMS[name];
}
