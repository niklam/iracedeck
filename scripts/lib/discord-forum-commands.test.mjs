/**
 * The commands behind `scripts/discord/feature-requests.mjs` (#1114), run
 * against a fake Discord client that serves a route table and records every
 * write. Reads assert the requests made; writes assert the exact bodies, since
 * a wrong body here is a wrong public post.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchAllPosts, readConfig, runList, runShow } from "./discord-forum-commands.mjs";

const GUILD = "1477659500851888219";
const CHANNEL = "1481298096632889366";
const CONFIG = { token: "tok", guildId: GUILD, channelId: CHANNEL };

const TAGS = [
  { id: "t-data", name: "Data", moderated: false },
  { id: "t-will", name: "Will Add", moderated: true },
  { id: "t-rel", name: "Released", moderated: true },
];

function thread(id, overrides = {}) {
  return { id, name: `Post ${id}`, parent_id: CHANNEL, applied_tags: [], message_count: 1, owner_id: "u1", ...overrides };
}

function message(id, overrides = {}) {
  return { id, content: `body ${id}`, timestamp: "2026-09-01T00:00:00.000Z", author: { id: "u1", username: "owwidius" }, reactions: [], ...overrides };
}

/** A fake client: `routes` maps exact paths to bodies; writes are recorded. */
function fakeClient(routes) {
  const writes = [];
  const client = {
    writes,
    get: vi.fn(async (path) => {
      if (!(path in routes)) throw new Error(`unexpected GET ${path}`);

      return typeof routes[path] === "function" ? routes[path]() : routes[path];
    }),
    post: vi.fn(async (path, body) => {
      writes.push({ method: "POST", path, body });

      return { id: "m-new" };
    }),
    patch: vi.fn(async (path, body) => {
      writes.push({ method: "PATCH", path, body });

      return { id: path.split("/").at(-1), applied_tags: body.applied_tags };
    }),
  };

  return client;
}

function fakeLog() {
  const log = { log: vi.fn(), error: vi.fn() };
  log.text = () => log.log.mock.calls.map((c) => c.join(" ")).join("\n");
  log.errors = () => log.error.mock.calls.map((c) => c.join(" ")).join("\n");

  return log;
}

const CHANNEL_ROUTE = `/channels/${CHANNEL}`;
const ACTIVE_ROUTE = `/guilds/${GUILD}/threads/active`;
const ARCHIVED_ROUTE = `/channels/${CHANNEL}/threads/archived/public?limit=100`;

describe("readConfig", () => {
  it("names every missing variable", () => {
    const result = readConfig("C:/nowhere", {});

    expect(result.error).toBe(
      "Missing DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_FEATURE_REQUESTS_CHANNEL_ID — set them in .env.local at the repo root (see .env.local.example).",
    );
  });

  it("reads the three variables", () => {
    const env = { DISCORD_BOT_TOKEN: "tok", DISCORD_GUILD_ID: GUILD, DISCORD_FEATURE_REQUESTS_CHANNEL_ID: CHANNEL };

    expect(readConfig("C:/nowhere", env)).toEqual(CONFIG);
  });
});

describe("fetchAllPosts", () => {
  it("pages the archived listing on the last archive_timestamp while has_more", async () => {
    const client = fakeClient({
      [ACTIVE_ROUTE]: { threads: [thread("30")] },
      [ARCHIVED_ROUTE]: { threads: [thread("20", { thread_metadata: { archived: true, archive_timestamp: "2026-08-01T00:00:00+00:00" } })], has_more: true },
      [`${ARCHIVED_ROUTE}&before=${encodeURIComponent("2026-08-01T00:00:00+00:00")}`]: { threads: [thread("10", { thread_metadata: { archived: true, archive_timestamp: "2026-07-01T00:00:00+00:00" } })], has_more: false },
    });

    const posts = await fetchAllPosts(client, CONFIG);

    expect(posts.map((p) => p.id)).toEqual(["30", "20", "10"]);
    expect(client.get).toHaveBeenCalledTimes(3);
  });
});

describe("runList", () => {
  const routes = {
    [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
    [ACTIVE_ROUTE]: { threads: [thread("30", { applied_tags: ["t-data"] }), thread("20", { applied_tags: ["t-data", "t-rel"] })] },
    [ARCHIVED_ROUTE]: { threads: [thread("10")], has_more: false },
  };

  it("prints every post newest first", async () => {
    const log = fakeLog();

    const code = await runList({ untagged: false, json: false }, { config: CONFIG, client: fakeClient(routes), log });

    expect(code).toBe(0);
    expect(log.log).toHaveBeenCalledTimes(3);
    expect(log.text()).toMatch(/^30 .*active.*\[Data\].*Post 30\n20 .*\[Data, Released\].*Post 20\n10 .*archived.*Post 10$/s);
  });

  it("--untagged keeps posts with no status tag, --json prints the describePost rows", async () => {
    const log = fakeLog();

    const code = await runList({ untagged: true, json: true }, { config: CONFIG, client: fakeClient(routes), log });

    expect(code).toBe(0);
    const rows = JSON.parse(log.text());
    expect(rows.map((r) => r.id)).toEqual(["30", "10"]);
    expect(rows[0]).toMatchObject({ title: "Post 30", tags: ["Data"], statusTag: null, standing: false, link: `https://discord.com/channels/${GUILD}/30` });
  });

  it("never lists a standing post as untagged", async () => {
    const log = fakeLog();
    const standing = { ...routes, [ACTIVE_ROUTE]: { threads: [thread("1516472792260808724")] }, [ARCHIVED_ROUTE]: { threads: [], has_more: false } };

    await runList({ untagged: true, json: true }, { config: CONFIG, client: fakeClient(standing), log });

    expect(JSON.parse(log.text())).toEqual([]);
  });
});

describe("runShow", () => {
  it("assembles starter, replies, votes and the author handle, oldest first", async () => {
    const client = fakeClient({
      [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
      "/channels/30": thread("30", { applied_tags: ["t-will"] }),
      "/channels/30/messages?limit=100": [
        message("32", { author: { id: "u2", username: "peter" }, content: "I like this" }),
        message("30", { reactions: [{ emoji: { name: "iRaceDeckHeart" }, count: 2 }] }),
      ],
    });
    const log = fakeLog();

    const code = await runShow({ postId: "30", json: true }, { config: CONFIG, client, log });

    expect(code).toBe(0);
    const post = JSON.parse(log.text());
    expect(post).toMatchObject({
      id: "30",
      statusTag: "Will Add",
      author: { id: "u1", handle: "owwidius" },
      votes: { total: 2, breakdown: [{ name: "iRaceDeckHeart", count: 2 }] },
      starter: { id: "30", content: "body 30" },
      replies: [{ id: "32", author: "peter", content: "I like this" }],
    });
  });

  it("refuses a thread that is not a post in the channel", async () => {
    const client = fakeClient({
      [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
      "/channels/77": thread("77", { parent_id: "elsewhere" }),
    });
    const log = fakeLog();

    const code = await runShow({ postId: "77", json: false }, { config: CONFIG, client, log });

    expect(code).toBe(1);
    expect(log.errors()).toBe("Error: 77 is not a post in the feature-requests channel.");
    expect(client.get).not.toHaveBeenCalledWith("/channels/77/messages?limit=100");
  });
});
