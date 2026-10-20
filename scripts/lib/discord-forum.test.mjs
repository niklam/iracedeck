/**
 * The pure half of the Discord forum tooling (#1114, #1460). Every function here
 * is a decision the spec spells out — which tag a GitHub state maps to, which
 * moves count as forward, what a post link looks like — so each test reads as
 * one line of that spec.
 */
import { describe, expect, it } from "vitest";

import {
  BUG_STATUS_TAGS,
  bugShouldPropose,
  bugTag,
  describePost,
  DISCORD_MESSAGE_LIMIT,
  featureRequestShouldPropose,
  featureRequestTag,
  lowestStableVersion,
  mergePosts,
  parseSourceLine,
  postLink,
  rank,
  replaceStatusTag,
  RESOLVED,
  resolveStatusTag,
  snowflakeToDate,
  sourceLine,
  STANDING_POST_IDS,
  STATUS_TAGS,
  statusTagOf,
  summarizeReactions,
  tagNamesOf,
  WONT_DO,
} from "./discord-forum.mjs";

const GUILD = "1477659500851888219";
const CHANNEL = "1481298096632889366";

/** The channel's real tags, by name; ids are stand-ins. */
const TAGS = [
  { id: "t-action", name: "Button / Action", moderated: false },
  { id: "t-data", name: "Data", moderated: false },
  { id: "t-re", name: "Race Engineer", moderated: false },
  { id: "t-will", name: "Will Add", moderated: true },
  { id: "t-prog", name: "In progress", moderated: true },
  { id: "t-done", name: "Completed", moderated: true },
  { id: "t-rel", name: "Released", moderated: true },
  { id: "t-wont", name: "Won't do", moderated: true },
];

function thread(id, overrides = {}) {
  return {
    id,
    name: `Post ${id}`,
    parent_id: CHANNEL,
    applied_tags: [],
    message_count: 0,
    owner_id: "u1",
    ...overrides,
  };
}

describe("constants", () => {
  it("names exactly the five status tags in lifecycle order", () => {
    expect(STATUS_TAGS).toEqual(["Will Add", "In progress", "Completed", "Released", "Won't do"]);
    expect(WONT_DO).toBe("Won't do");
    expect(DISCORD_MESSAGE_LIMIT).toBe(2000);
  });

  it("lists the name-collection thread as standing", () => {
    expect(STANDING_POST_IDS).toContain("1516472792260808724");
  });
});

describe("snowflakeToDate", () => {
  it("decodes the timestamp bits against the Discord epoch", () => {
    // (1481298096632889366 >> 22) ms after 2015-01-01 — verified with node before writing the literal
    expect(snowflakeToDate("1481298096632889366").toISOString()).toBe("2026-03-11T14:29:47.425Z");
  });
});

describe("mergePosts", () => {
  it("keeps only this channel's threads, dedupes, marks archived, sorts newest first", () => {
    const active = [thread("30"), thread("99", { parent_id: "other" })];
    const archivedPages = [
      { threads: [thread("20"), thread("30")], has_more: true },
      { threads: [thread("10")], has_more: false },
    ];

    const posts = mergePosts({ active, archivedPages, channelId: CHANNEL });

    expect(posts.map((p) => p.id)).toEqual(["30", "20", "10"]);
    expect(posts.map((p) => p.archived)).toEqual([false, true, true]);
  });

  it("sorts by snowflake value, not string order", () => {
    const posts = mergePosts({ active: [thread("9"), thread("10")], archivedPages: [], channelId: CHANNEL });

    expect(posts.map((p) => p.id)).toEqual(["10", "9"]);
  });
});

describe("tags", () => {
  it("maps applied ids to names and falls back to the id", () => {
    expect(tagNamesOf(["t-data", "t-will", "gone"], TAGS)).toEqual(["Data", "Will Add", "gone"]);
  });

  it("finds the status tag among category tags", () => {
    expect(statusTagOf(["Data", "In progress"])).toBe("In progress");
    expect(statusTagOf(["Data"])).toBeNull();
  });

  it("resolves a status tag by exact name", () => {
    expect(resolveStatusTag("Will Add", TAGS)).toEqual(TAGS[3]);
    expect(() => resolveStatusTag("Released!", TAGS)).toThrow(
      /Unknown status tag "Released!"\. Valid: Will Add, In progress, Completed, Released, Won't do/,
    );
    expect(() =>
      resolveStatusTag(
        "Released",
        TAGS.filter((t) => t.name !== "Released"),
      ),
    ).toThrow(/does not exist on the channel/);
  });

  it("replaces the status tag and keeps every category tag", () => {
    expect(replaceStatusTag(["t-data", "t-will", "t-re"], TAGS[6], TAGS)).toEqual(["t-data", "t-re", "t-rel"]);
    expect(replaceStatusTag([], TAGS[3], TAGS)).toEqual(["t-will"]);
  });

  it("refuses more than five tags", () => {
    expect(() => replaceStatusTag(["a", "b", "c", "d", "e"], TAGS[3], TAGS)).toThrow(/at most 5 tags/);
  });
});

describe("describePost", () => {
  it("flattens a thread into the list row", () => {
    const post = describePost(
      thread("1481298096632889366", {
        name: "Wind arrow",
        applied_tags: ["t-data", "t-rel"],
        message_count: 5,
        thread_metadata: { archived: true },
      }),
      TAGS,
      GUILD,
    );

    expect(post).toEqual({
      id: "1481298096632889366",
      title: "Wind arrow",
      link: `https://discord.com/channels/${GUILD}/1481298096632889366`,
      created: "2026-03-11T14:29:47.425Z",
      archived: true,
      replies: 5,
      ownerId: "u1",
      tags: ["Data", "Released"],
      statusTag: "Released",
      standing: false,
    });
  });

  it("flags the standing post", () => {
    expect(describePost(thread("1516472792260808724"), TAGS, GUILD).standing).toBe(true);
  });
});

describe("links and the source line", () => {
  it("builds a post link", () => {
    expect(postLink(GUILD, "123")).toBe(`https://discord.com/channels/${GUILD}/123`);
  });

  it("parses the source line, not the first Discord URL in the body", () => {
    const link = postLink(GUILD, "123");
    const body = `See https://discord.com/channels/${GUILD}/999/1000 for context.\n\nRequested on Discord: ${link} by owwidius (3 ❤️)`;

    expect(parseSourceLine(body)).toEqual({ guildId: GUILD, postId: "123" });
    expect(parseSourceLine(`Related: https://discord.com/channels/${GUILD}/999`)).toBeNull();
    expect(parseSourceLine("nothing here")).toBeNull();
    expect(parseSourceLine(undefined)).toBeNull();
  });

  it("only matches a source line at the start of its own line", () => {
    expect(parseSourceLine(`> Requested on Discord: ${postLink(GUILD, "123")} by x (0 ❤️)`)).toBeNull();
    expect(parseSourceLine(`x\r\nRequested on Discord: ${postLink(GUILD, "123")} by x (0 ❤️)\r\n`)).toEqual({
      guildId: GUILD,
      postId: "123",
    });
  });

  it("formats the source line exactly as the spec states it", () => {
    expect(sourceLine({ link: "https://discord.com/channels/1/2", handle: "owwidius", votes: 3 })).toBe(
      "Requested on Discord: https://discord.com/channels/1/2 by owwidius (3 ❤️)",
    );
  });

  it("formats a bug's source line with Reported", () => {
    expect(
      sourceLine({ link: "https://discord.com/channels/1/2", handle: "owwidius", votes: 0, verb: "Reported" }),
    ).toBe("Reported on Discord: https://discord.com/channels/1/2 by owwidius (0 ❤️)");
  });

  it("parses both verbs and refuses any other", () => {
    const link = postLink(GUILD, "123");

    expect(parseSourceLine(`Requested on Discord: ${link} by x (1 ❤️)`)).toEqual({ guildId: GUILD, postId: "123" });
    expect(parseSourceLine(`Reported on Discord: ${link} by x (1 ❤️)`)).toEqual({ guildId: GUILD, postId: "123" });
    expect(parseSourceLine(`Posted on Discord: ${link} by x (1 ❤️)`)).toBeNull();
    expect(parseSourceLine(`reported on Discord: ${link} by x (1 ❤️)`)).toBeNull();
    expect(parseSourceLine(`Requested Reported on Discord: ${link} by x (1 ❤️)`)).toBeNull();
    expect(parseSourceLine(`> Reported on Discord: ${link} by x (1 ❤️)`)).toBeNull();
  });
});

describe("tags with the bugs forum's list", () => {
  const BUG_TAGS = [
    { id: "b-ui", name: "UI", moderated: false },
    { id: "b-res", name: "Resolved", moderated: true },
    // A feature-requests name on the bugs channel is a category tag there.
    { id: "b-rel", name: "Released", moderated: false },
  ];

  it("finds, resolves and replaces only the bugs forum's status tag", () => {
    expect(BUG_STATUS_TAGS).toEqual([RESOLVED]);
    expect(statusTagOf(["UI", "Released"], BUG_STATUS_TAGS)).toBeNull();
    expect(statusTagOf(["UI", "Resolved"], BUG_STATUS_TAGS)).toBe("Resolved");
    expect(resolveStatusTag("Resolved", BUG_TAGS, BUG_STATUS_TAGS)).toEqual(BUG_TAGS[1]);
    expect(() => resolveStatusTag("Released", BUG_TAGS, BUG_STATUS_TAGS)).toThrow(
      'Unknown status tag "Released". Valid: Resolved',
    );
    expect(replaceStatusTag(["b-ui", "b-rel"], BUG_TAGS[1], BUG_TAGS, BUG_STATUS_TAGS)).toEqual([
      "b-ui",
      "b-rel",
      "b-res",
    ]);
  });

  it("describes a post's status tag from the list it is given", () => {
    const post = describePost(thread("40", { applied_tags: ["b-rel", "b-res"] }), BUG_TAGS, GUILD, BUG_STATUS_TAGS);

    expect(post).toMatchObject({ tags: ["Released", "Resolved"], statusTag: "Resolved" });
  });
});

describe("summarizeReactions", () => {
  it("totals every emoji and keeps the breakdown", () => {
    const message = {
      reactions: [
        { emoji: { name: "iRaceDeckHeart" }, count: 4 },
        { emoji: { name: "👍" }, count: 1 },
      ],
    };

    expect(summarizeReactions(message)).toEqual({
      total: 5,
      breakdown: [
        { name: "iRaceDeckHeart", count: 4 },
        { name: "👍", count: 1 },
      ],
    });
    expect(summarizeReactions({})).toEqual({ total: 0, breakdown: [] });
  });
});

describe("featureRequestTag", () => {
  const open = { state: "OPEN", stateReason: null, assignees: [], milestone: null };

  it("follows the follow-up table", () => {
    expect(featureRequestTag(open)).toBe("Will Add");
    expect(featureRequestTag({ ...open, assignees: [{ login: "niklam" }] })).toBe("In progress");
    expect(featureRequestTag({ ...open, milestone: { title: "3.2.0" } })).toBe("In progress");
    expect(featureRequestTag({ ...open, stateReason: "REOPENED" })).toBe("Will Add");
    expect(featureRequestTag({ ...open, state: "CLOSED", stateReason: "COMPLETED" })).toBe("Completed");
    expect(featureRequestTag({ ...open, state: "CLOSED", stateReason: "COMPLETED" }, "v3.2.0")).toBe("Released");
    expect(featureRequestTag({ ...open, state: "CLOSED", stateReason: "NOT_PLANNED" })).toBe(WONT_DO);
  });

  it("has no tag for an issue closed as a duplicate", () => {
    // None of the five fits a duplicate: the post should point at the
    // canonical issue by hand, not be marked Completed because it is closed.
    expect(featureRequestTag({ ...open, state: "CLOSED", stateReason: "DUPLICATE" })).toBeNull();
    expect(featureRequestTag({ ...open, state: "CLOSED", stateReason: "DUPLICATE" }, "v3.2.0")).toBeNull();
  });
});

describe("bugTag", () => {
  const open = { state: "OPEN", stateReason: null, assignees: [], milestone: null };
  const closed = (stateReason) => ({ ...open, state: "CLOSED", stateReason });

  it("is Resolved only for a bug closed as completed and shipped in a stable tag", () => {
    expect(bugTag(closed("COMPLETED"), "v3.6.1")).toBe(RESOLVED);
    expect(bugTag(closed("COMPLETED"), lowestStableVersion(["v3.7.0-rc.1", "v3.6.1"]))).toBe(RESOLVED);
  });

  it("is null for every other state, a pre-release-only fix included", () => {
    expect(bugTag(open)).toBeNull();
    expect(bugTag({ ...open, assignees: [{ login: "niklam" }], milestone: { title: "3.7.0" } }, "v3.6.1")).toBeNull();
    expect(bugTag(closed("NOT_PLANNED"), "v3.6.1")).toBeNull();
    expect(bugTag(closed("DUPLICATE"), "v3.6.1")).toBeNull();
    expect(bugTag(closed("COMPLETED"))).toBeNull();
    expect(bugTag(closed("COMPLETED"), lowestStableVersion(["v3.7.0-rc.1"]))).toBeNull();
  });
});

describe("rank and featureRequestShouldPropose", () => {
  it("ranks the lifecycle with none at zero", () => {
    expect([null, "Will Add", "In progress", "Completed", "Released"].map(rank)).toEqual([0, 1, 2, 3, 4]);
  });

  it("proposes only forward moves, with Won't do reachable from anywhere and terminal", () => {
    expect(featureRequestShouldPropose(null, "Will Add")).toBe(true);
    expect(featureRequestShouldPropose("Will Add", "Released")).toBe(true);
    expect(featureRequestShouldPropose("Released", "Completed")).toBe(false);
    expect(featureRequestShouldPropose("In progress", "In progress")).toBe(false);
    expect(featureRequestShouldPropose("Released", WONT_DO)).toBe(true);
    expect(featureRequestShouldPropose(WONT_DO, "Completed")).toBe(false);
    expect(featureRequestShouldPropose(WONT_DO, WONT_DO)).toBe(false);
  });

  it("never proposes a move to no tag", () => {
    expect(featureRequestShouldPropose("Will Add", null)).toBe(false);
    expect(featureRequestShouldPropose(null, null)).toBe(false);
    expect(rank(null)).toBe(0);
  });
});

describe("bugShouldPropose", () => {
  it("proposes Resolved over any post not already carrying it, and nothing else", () => {
    expect(bugShouldPropose(null, RESOLVED)).toBe(true);
    expect(bugShouldPropose(RESOLVED, RESOLVED)).toBe(false);
    expect(bugShouldPropose(null, null)).toBe(false);
    expect(bugShouldPropose(RESOLVED, null)).toBe(false);
    // A feature-requests tag is never a bugs-forum proposal.
    expect(bugShouldPropose(null, "Released")).toBe(false);
  });
});

describe("lowestStableVersion", () => {
  it("picks the lowest stable tag and ignores pre-releases", () => {
    expect(lowestStableVersion(["v3.2.0", "v3.1.0", "v3.2.0-rc.1", "v3.10.0"])).toBe("v3.1.0");
    expect(lowestStableVersion(["v3.10.0", "v3.9.0"])).toBe("v3.9.0");
    expect(lowestStableVersion(["v3.2.0-dev.0"])).toBeNull();
    expect(lowestStableVersion([])).toBeNull();
  });

  it("follows semver: build metadata is stable, a bare number or a missing v is not a release tag", () => {
    expect(lowestStableVersion(["v3.3.0", "v3.2.0+build"])).toBe("v3.2.0+build");
    expect(lowestStableVersion(["3.2.0", "v3.2", "latest"])).toBeNull();
  });
});
