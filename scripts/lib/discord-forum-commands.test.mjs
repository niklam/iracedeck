/**
 * The commands behind `scripts/discord/feature-requests.mjs` (#1114), run
 * against a fake Discord client that serves a route table and records every
 * write. Reads assert the requests made; writes assert the exact bodies, since
 * a wrong body here is a wrong public post.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchAllPosts, readConfig, runFollowUp, runList, runReply, runShow, runTag } from "./discord-forum-commands.mjs";

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

  it("never promotes a reply to starter when the original message was deleted", async () => {
    // The starter shares the post's id. With it gone, the oldest reply is not
    // the request, its author is not the requester, and its reactions are not
    // votes — and `show --json` is what credits the issue's source line.
    const client = fakeClient({
      [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
      "/channels/30": thread("30", { owner_id: "u1" }),
      "/channels/30/messages?limit=100": [
        message("32", { author: { id: "u2", username: "peter" }, content: "I like this", reactions: [{ emoji: { name: "iRaceDeckHeart" }, count: 5 }] }),
      ],
    });
    const log = fakeLog();

    const code = await runShow({ postId: "30", json: true }, { config: CONFIG, client, log });

    expect(code).toBe(0);
    const post = JSON.parse(log.text());
    expect(post).toMatchObject({
      author: { id: "u1", handle: null },
      votes: { total: 0, breakdown: [] },
      starter: null,
      replies: [{ id: "32", author: "peter", content: "I like this" }],
    });
  });

  it("survives a post with no messages at all and says the original was deleted", async () => {
    const client = fakeClient({
      [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
      "/channels/30": thread("30"),
      "/channels/30/messages?limit=100": [],
    });
    const log = fakeLog();

    const code = await runShow({ postId: "30", json: false }, { config: CONFIG, client, log });

    expect(code).toBe(0);
    expect(log.errors()).toBe("");
    expect(log.text()).toContain("by (unknown)");
    expect(log.text()).toContain("original message was deleted");
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

describe("runReply", () => {
  const routes = { "/channels/30": thread("30") };

  it("posts the text with mentions disabled and prints the message link", async () => {
    const client = fakeClient(routes);
    const log = fakeLog();

    const code = await runReply({ postId: "30", text: "Thanks — tracked as #1", dryRun: false }, { config: CONFIG, client, log });

    expect(code).toBe(0);
    expect(client.writes).toEqual([{ method: "POST", path: "/channels/30/messages", body: { content: "Thanks — tracked as #1", allowed_mentions: { parse: [] } } }]);
    expect(log.text()).toBe(`Posted: https://discord.com/channels/${GUILD}/30/m-new`);
  });

  it("--dry-run prints the request and sends nothing", async () => {
    const client = fakeClient(routes);
    const log = fakeLog();

    const code = await runReply({ postId: "30", text: "hello", dryRun: true }, { config: CONFIG, client, log });

    expect(code).toBe(0);
    expect(client.writes).toEqual([]);
    expect(log.text()).toContain("DRY RUN");
    expect(log.text()).toContain('"content": "hello"');
  });

  it("refuses empty text and text over the Discord limit", async () => {
    const client = fakeClient(routes);
    const log = fakeLog();

    expect(await runReply({ postId: "30", text: "   ", dryRun: false }, { config: CONFIG, client, log })).toBe(1);
    expect(await runReply({ postId: "30", text: "x".repeat(2001), dryRun: false }, { config: CONFIG, client, log })).toBe(1);
    expect(client.writes).toEqual([]);
    expect(log.errors()).toContain("Error: reply text is empty.");
    expect(log.errors()).toContain("Error: reply is 2001 characters; Discord's limit is 2000. Shorten it.");
  });

  it("refuses a standing post and a thread outside the channel", async () => {
    const client = fakeClient({ "/channels/1516472792260808724": thread("1516472792260808724"), "/channels/77": thread("77", { parent_id: "elsewhere" }) });
    const log = fakeLog();

    expect(await runReply({ postId: "1516472792260808724", text: "hi", dryRun: false }, { config: CONFIG, client, log })).toBe(1);
    expect(await runReply({ postId: "77", text: "hi", dryRun: false }, { config: CONFIG, client, log })).toBe(1);
    expect(client.writes).toEqual([]);
    expect(log.errors()).toContain("Error: 1516472792260808724 is a standing post; this tool never writes to it.");
  });
});

describe("runTag", () => {
  const routes = {
    [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
    "/channels/30": thread("30", { applied_tags: ["t-data", "t-will"] }),
    "/channels/20": thread("20", { applied_tags: ["t-data"], thread_metadata: { archived: true } }),
  };

  it("replaces the status tag, keeps category tags, and reports the result", async () => {
    const client = fakeClient(routes);
    const log = fakeLog();

    const code = await runTag({ postId: "30", tagName: "Released", dryRun: false }, { config: CONFIG, client, log });

    expect(code).toBe(0);
    expect(client.writes).toEqual([{ method: "PATCH", path: "/channels/30", body: { applied_tags: ["t-data", "t-rel"] } }]);
    expect(log.text()).toBe('Tagged "Post 30": [Data, Released]');
  });

  it("un-archives an archived post in the same request", async () => {
    const client = fakeClient(routes);

    await runTag({ postId: "20", tagName: "Will Add", dryRun: false }, { config: CONFIG, client, log: fakeLog() });

    expect(client.writes[0].body).toEqual({ applied_tags: ["t-data", "t-will"], archived: false });
  });

  it("--dry-run patches nothing", async () => {
    const client = fakeClient(routes);
    const log = fakeLog();

    expect(await runTag({ postId: "30", tagName: "Released", dryRun: true }, { config: CONFIG, client, log })).toBe(0);
    expect(client.writes).toEqual([]);
    expect(log.text()).toContain("DRY RUN");
  });

  it("rejects an unknown tag before touching the post", async () => {
    const client = fakeClient(routes);
    const log = fakeLog();

    expect(await runTag({ postId: "30", tagName: "Done", dryRun: false }, { config: CONFIG, client, log })).toBe(1);
    expect(log.errors()).toBe("Error: Unknown status tag \"Done\". Valid: Will Add, In progress, Completed, Released, Won't do");
    expect(client.get).not.toHaveBeenCalledWith("/channels/30");
  });

  it("refuses a standing post", async () => {
    const client = fakeClient({ ...routes, "/channels/1516472792260808724": thread("1516472792260808724", { applied_tags: ["t-will"] }) });
    const log = fakeLog();

    // "Released" exists on the fake channel, so the only thing that can stop
    // this write is the standing-post check itself — not a tag lookup failing
    // first (which is what a tag absent from TAGS used to exercise instead).
    expect(await runTag({ postId: "1516472792260808724", tagName: "Released", dryRun: false }, { config: CONFIG, client, log })).toBe(1);
    expect(client.writes).toEqual([]);
    expect(log.errors()).toContain("is a standing post");
    expect(client.get).not.toHaveBeenCalledWith("/channels/1516472792260808724");
  });
});

describe("runFollowUp", () => {
  const link = (id) => `https://discord.com/channels/${GUILD}/${id}`;
  const issues = [
    { number: 1, title: "Open, untouched", url: "u/1", state: "OPEN", stateReason: null, assignees: [], milestone: null, body: `x\n\nRequested on Discord: ${link("30")} by a (1 ❤️)` },
    { number: 2, title: "In progress", url: "u/2", state: "OPEN", stateReason: null, assignees: [{ login: "niklam" }], milestone: null, body: `Requested on Discord: ${link("20")} by b (0 ❤️)` },
    { number: 3, title: "Shipped", url: "u/3", state: "CLOSED", stateReason: "COMPLETED", assignees: [], milestone: null, body: `Requested on Discord: ${link("10")} by c (2 ❤️)` },
    { number: 4, title: "No link", url: "u/4", state: "OPEN", stateReason: null, assignees: [], milestone: null, body: "nothing" },
    { number: 5, title: "Standing", url: "u/5", state: "CLOSED", stateReason: "COMPLETED", assignees: [], milestone: null, body: `Requested on Discord: ${link("1516472792260808724")} by d (0 ❤️)` },
  ];
  const posts = [
    thread("30", { applied_tags: [] }),
    thread("20", { applied_tags: ["t-will"] }),
    thread("10", { applied_tags: ["t-rel"], thread_metadata: { archived: true } }),
    thread("1516472792260808724", { applied_tags: ["t-will"] }),
  ];
  const routes = {
    [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
    [ACTIVE_ROUTE]: { threads: posts },
    [ARCHIVED_ROUTE]: { threads: [], has_more: false },
  };

  function fakeExec() {
    return vi.fn((file, args) => {
      const cmd = [file, ...args].join(" ");

      if (cmd.startsWith("gh issue list")) return JSON.stringify(issues);
      if (cmd === "git fetch --tags --quiet") return "";
      if (cmd.startsWith("gh issue view 3")) return JSON.stringify({ closedByPullRequestsReferences: [{ number: 33 }] });
      if (cmd.startsWith("gh issue view 5")) return JSON.stringify({ closedByPullRequestsReferences: [] });
      if (cmd.startsWith("gh pr view 33")) return JSON.stringify({ mergeCommit: { oid: "abc123" } });
      if (cmd === "git tag --contains abc123") return "v3.2.0\nv3.2.0-rc.1\nv3.3.0\n";

      throw new Error(`unexpected exec: ${cmd}`);
    });
  }

  it("computes one row per issue and proposes only forward moves", async () => {
    const log = fakeLog();
    const exec = fakeExec();

    const code = await runFollowUp({ json: true }, { config: CONFIG, client: fakeClient(routes), log, exec });

    expect(code).toBe(0);
    const rows = JSON.parse(log.text());
    expect(rows).toEqual([
      { issue: 1, title: "Open, untouched", url: "u/1", state: "OPEN", post: { id: "30", title: "Post 30", link: link("30") }, current: null, expected: "Will Add", version: null, propose: true, note: null },
      { issue: 2, title: "In progress", url: "u/2", state: "OPEN", post: { id: "20", title: "Post 20", link: link("20") }, current: "Will Add", expected: "In progress", version: null, propose: true, note: null },
      { issue: 3, title: "Shipped", url: "u/3", state: "CLOSED", post: { id: "10", title: "Post 10", link: link("10") }, current: "Released", expected: "Released", version: "v3.2.0", propose: false, note: null },
      { issue: 4, title: "No link", url: "u/4", state: "OPEN", post: null, current: null, expected: "Will Add", version: null, propose: false, note: "no Discord post link in the issue body" },
      { issue: 5, title: "Standing", url: "u/5", state: "CLOSED", post: { id: "1516472792260808724", title: "Post 1516472792260808724", link: link("1516472792260808724") }, current: "Will Add", expected: "Completed", version: null, propose: false, note: "standing post; never changed by this tool" },
    ]);
    expect(exec).toHaveBeenCalledWith("git", ["fetch", "--tags", "--quiet"]);
  });

  it("prints a readable table by default", async () => {
    const log = fakeLog();

    await runFollowUp({ json: false }, { config: CONFIG, client: fakeClient(routes), log, exec: fakeExec() });

    expect(log.text()).toContain("#1");
    expect(log.text()).toMatch(/#1 .*none -> Will Add.*PROPOSE/s);
    expect(log.text()).toMatch(/#3 .*Released -> Released.*v3\.2\.0/s);
    expect(log.text()).toMatch(/#4 .*no Discord post link/s);
  });

  it("uses gh with the label filter and json fields the spec names", async () => {
    const exec = fakeExec();

    await runFollowUp({ json: true }, { config: CONFIG, client: fakeClient(routes), log: fakeLog(), exec });

    expect(exec.mock.calls[0]).toEqual(["gh", ["issue", "list", "--label", "discord", "--state", "all", "--limit", "500", "--json", "number,title,url,state,stateReason,assignees,milestone,body"]]);
  });
});
