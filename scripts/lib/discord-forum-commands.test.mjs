/**
 * The commands behind `scripts/discord/feature-requests.mjs` (#1114), run
 * against a fake Discord client that serves a route table and records every
 * write. Reads assert the requests made; writes assert the exact bodies, since
 * a wrong body here is a wrong public post.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchAllPosts, fetchPostMessages, readConfig, runFollowUp, runList, runReply, runShow, runTag } from "./discord-forum-commands.mjs";

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

  it("reads .env.local without letting the token into process.env", () => {
    // The token must never reach this process's environment: every child
    // (gh, git) would inherit it. A shell-exported value would still win over
    // the file, so the three variables are cleared for the duration.
    const saved = Object.fromEntries(["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_FEATURE_REQUESTS_CHANNEL_ID"].map((name) => [name, process.env[name]]));
    const root = mkdtempSync(join(tmpdir(), "ird-discord-"));

    try {
      for (const name of Object.keys(saved)) delete process.env[name];
      writeFileSync(join(root, ".env.local"), `DISCORD_BOT_TOKEN="tok"\nDISCORD_GUILD_ID=${GUILD}\nDISCORD_FEATURE_REQUESTS_CHANNEL_ID=${CHANNEL}\n`);

      expect(readConfig(root)).toEqual(CONFIG);
      expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
      expect(process.env.DISCORD_GUILD_ID).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }

      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fetchAllPosts", () => {
  const archived = (id, stamp) => thread(id, { thread_metadata: { archived: true, archive_timestamp: stamp } });

  it("fails loud when the archived listing still has more after the page cap", async () => {
    const client = fakeClient({});
    client.get = vi.fn(async (path) => (path === ACTIVE_ROUTE ? { threads: [] } : { threads: [archived("20", "2026-08-01T00:00:00+00:00")], has_more: true }));

    await expect(fetchAllPosts(client, CONFIG)).rejects.toThrow("archived-thread listing truncated after 20 pages; raise MAX_ARCHIVED_PAGES or report this");
    expect(client.get.mock.calls.filter(([path]) => path.startsWith(ARCHIVED_ROUTE))).toHaveLength(20);
  });

  it("fails loud when a page says has_more but its last thread carries no archive_timestamp", async () => {
    const client = fakeClient({
      [ACTIVE_ROUTE]: { threads: [] },
      [ARCHIVED_ROUTE]: { threads: [thread("20", { thread_metadata: { archived: true } })], has_more: true },
    });

    await expect(fetchAllPosts(client, CONFIG)).rejects.toThrow("archived-thread listing cannot page further: last thread has no archive_timestamp");
    expect(client.get).toHaveBeenCalledTimes(2);
  });

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

describe("fetchPostMessages", () => {
  it("pages on the oldest id and returns oldest first", async () => {
    const client = fakeClient({
      "/channels/30/messages?limit=100": Array.from({ length: 100 }, (_, i) => message(String(300 - i))),
      "/channels/30/messages?limit=100&before=201": [message("31"), message("30")],
    });

    const messages = await fetchPostMessages(client, "30");

    expect(messages).toHaveLength(102);
    expect(messages[0].id).toBe("30");
    expect(messages.at(-1).id).toBe("300");
  });

  it("fails loud when the post has more messages than the page cap covers", async () => {
    const client = fakeClient({});
    let next = 100000;
    client.get = vi.fn(async () => Array.from({ length: 100 }, () => message(String(next--))));

    await expect(fetchPostMessages(client, "30")).rejects.toThrow("post has more than 1000 messages; raise MAX_MESSAGE_PAGES");
    expect(client.get).toHaveBeenCalledTimes(10);
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
      sourceLine: `Requested on Discord: https://discord.com/channels/${GUILD}/30 by owwidius (2 ❤️)`,
    });
  });

  it("prints the source line last so it can be copied into the issue verbatim", async () => {
    const client = fakeClient({
      [CHANNEL_ROUTE]: { id: CHANNEL, available_tags: TAGS },
      "/channels/30": thread("30"),
      "/channels/30/messages?limit=100": [message("30", { reactions: [{ emoji: { name: "iRaceDeckHeart" }, count: 2 }] })],
    });
    const log = fakeLog();

    await runShow({ postId: "30", json: false }, { config: CONFIG, client, log });

    expect(log.text().split("\n").at(-1)).toBe(`source line: Requested on Discord: https://discord.com/channels/${GUILD}/30 by owwidius (2 ❤️)`);
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
      sourceLine: `Requested on Discord: https://discord.com/channels/${GUILD}/30 by unknown (0 ❤️)`,
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
  const sourced = (id, guild = GUILD) => `Requested on Discord: https://discord.com/channels/${guild}/${id} by someone (1 ❤️)`;
  const issue = (number, title, overrides = {}) => ({
    number,
    title,
    url: `u/${number}`,
    state: "OPEN",
    stateReason: null,
    assignees: [],
    milestone: null,
    body: sourced(String(number)),
    closedByPullRequestsReferences: [],
    ...overrides,
  });
  const shipped = (number, title, overrides = {}) => issue(number, title, { state: "CLOSED", stateReason: "COMPLETED", ...overrides });

  const issues = [
    issue(1, "Open, untouched", { body: `x\n\nRequested on Discord: ${link("30")} by a (1 ❤️)` }),
    issue(2, "In progress", { assignees: [{ login: "niklam" }], body: sourced("20") }),
    shipped(3, "Shipped", { body: sourced("10"), closedByPullRequestsReferences: [{ number: 33 }] }),
    issue(4, "No link", { body: `nothing, though ${link("30")} is mentioned` }),
    shipped(5, "Standing", { body: sourced("1516472792260808724") }),
    issue(6, "Duplicate", { state: "CLOSED", stateReason: "DUPLICATE", body: sourced("20") }),
    issue(7, "Other server", { body: sourced("30", "999") }),
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

  // The exact commands the release lookup runs, as `exec` sees them joined.
  const prView = (pr) => `gh pr view ${pr} --json mergeCommit`;
  const timeline = (n) => `gh api repos/{owner}/{repo}/issues/${n}/timeline --paginate --jq [.[] | select(.event == "closed") | .commit_id] | map(select(. != null))`;
  const gitLog = (n) => `git log --all --fixed-strings --grep=(#${n}) --format=%H%x09%s`;
  const gitTag = (sha) => `git tag --contains ${sha}`;
  const LIST = "gh issue list --label discord --state all --limit 500 --json number,title,url,state,stateReason,assignees,milestone,body,closedByPullRequestsReferences";

  /** `lookups` maps a joined command to its stdout, or to an Error to throw. */
  function fakeExec(list = issues, lookups = {}) {
    return vi.fn((file, args) => {
      const cmd = [file, ...args].join(" ");

      if (cmd === LIST) return JSON.stringify(list);
      if (cmd === "git fetch --tags --quiet") return "";
      if (cmd in lookups) {
        if (lookups[cmd] instanceof Error) throw lookups[cmd];

        return lookups[cmd];
      }

      throw new Error(`unexpected exec: ${cmd}`);
    });
  }

  const lookupCalls = (exec) => exec.mock.calls.map(([file, args]) => [file, ...args].join(" ")).filter((cmd) => cmd !== LIST && cmd !== "git fetch --tags --quiet");

  const shippedLookups = {
    [prView(33)]: JSON.stringify({ mergeCommit: { oid: "abc123" } }),
    [timeline(3)]: "[]",
    [gitLog(3)]: "",
    [gitTag("abc123")]: "v3.2.0\nv3.2.0-rc.1\nv3.3.0\n",
  };

  async function rowsFor(list, lookups) {
    const log = fakeLog();
    const exec = fakeExec(list, lookups);
    const code = await runFollowUp({ json: true }, { config: CONFIG, client: fakeClient(routes), log, exec });

    expect(code).toBe(0);

    return { rows: JSON.parse(log.text()), exec };
  }

  it("computes one row per issue and proposes only forward moves", async () => {
    const { rows, exec } = await rowsFor(issues, shippedLookups);

    expect(rows).toEqual([
      { issue: 1, title: "Open, untouched", url: "u/1", state: "OPEN", post: { id: "30", title: "Post 30", link: link("30") }, current: null, expected: "Will Add", version: null, propose: true, note: null },
      { issue: 2, title: "In progress", url: "u/2", state: "OPEN", post: { id: "20", title: "Post 20", link: link("20") }, current: "Will Add", expected: "In progress", version: null, propose: true, note: null },
      { issue: 3, title: "Shipped", url: "u/3", state: "CLOSED", post: { id: "10", title: "Post 10", link: link("10") }, current: "Released", expected: "Released", version: "v3.2.0", propose: false, note: null },
      { issue: 4, title: "No link", url: "u/4", state: "OPEN", post: null, current: null, expected: "Will Add", version: null, propose: false, note: "no source line in the issue body" },
      { issue: 5, title: "Standing", url: "u/5", state: "CLOSED", post: { id: "1516472792260808724", title: "Post 1516472792260808724", link: link("1516472792260808724") }, current: "Will Add", expected: "Completed", version: null, propose: false, note: "standing post; never changed by this tool" },
      { issue: 6, title: "Duplicate", url: "u/6", state: "CLOSED", post: { id: "20", title: "Post 20", link: link("20") }, current: "Will Add", expected: null, version: null, propose: false, note: "closed as duplicate; point the post at the canonical issue by hand" },
      { issue: 7, title: "Other server", url: "u/7", state: "OPEN", post: null, current: null, expected: "Will Add", version: null, propose: false, note: "source line points at another server" },
    ]);
    expect(exec).toHaveBeenCalledWith("git", ["fetch", "--tags", "--quiet"]);
  });

  it("looks up a release only for a completed issue whose post it may change", async () => {
    // Issue 3 is the only one that earns the gh/git round trips: the standing
    // post (5) and the link-less issue (4) are never looked up, nor is anything
    // still open.
    const { exec } = await rowsFor(issues, shippedLookups);

    expect(lookupCalls(exec)).toEqual([prView(33), timeline(3), gitLog(3), gitTag("abc123")]);
  });

  it("prints a readable table by default", async () => {
    const log = fakeLog();

    await runFollowUp({ json: false }, { config: CONFIG, client: fakeClient(routes), log, exec: fakeExec(issues, shippedLookups) });

    expect(log.text()).toMatch(/#1 .*none -> Will Add {2}PROPOSE\n/s);
    expect(log.text()).toMatch(/#3 .*Released -> Released \(v3\.2\.0\) {2}up to date\n/s);
    expect(log.text()).toMatch(/#4 .*none -> Will Add {2}no change {2}\(note: no source line in the issue body\)\n/s);
    expect(log.text()).toMatch(/#5 .*Will Add -> Completed {2}no change {2}\(note: standing post; never changed by this tool\)\n/s);
    expect(log.text()).toMatch(/#6 .*Will Add -> none {2}no change {2}\(note: closed as duplicate; point the post at the canonical issue by hand\)\n/s);
    expect(log.text()).toMatch(/7 Discord-sourced issues, 2 proposed changes\.$/);
  });

  it("uses gh with the label filter and json fields the spec names", async () => {
    const exec = fakeExec(issues, shippedLookups);

    await runFollowUp({ json: true }, { config: CONFIG, client: fakeClient(routes), log: fakeLog(), exec });

    expect(exec.mock.calls[0]).toEqual(["gh", ["issue", "list", "--label", "discord", "--state", "all", "--limit", "500", "--json", "number,title,url,state,stateReason,assignees,milestone,body,closedByPullRequestsReferences"]]);
  });

  describe("release detection", () => {
    const one = (overrides, lookups) => rowsFor([shipped(8, "Closed", { body: sourced("30"), ...overrides })], lookups).then(({ rows }) => rows[0]);

    it("finds the shipping commit through the timeline's closed event when no PR is linked", async () => {
      const row = await one({}, { [timeline(8)]: JSON.stringify(["def456"]), [gitLog(8)]: "", [gitTag("def456")]: "v3.1.0\n" });

      expect(row).toMatchObject({ expected: "Released", version: "v3.1.0", propose: true, note: null });
    });

    it("finds the shipping commit through its squash-merge subject when nothing else links it", async () => {
      const row = await one({}, { [timeline(8)]: "[]", [gitLog(8)]: "fed789\tfeat(actions): the thing (#8) (#9)\n", [gitTag("fed789")]: "v3.1.0\n" });

      expect(row).toMatchObject({ expected: "Released", version: "v3.1.0", propose: true, note: null });
    });

    it("ignores a spec commit and a body-only mention: only a subject carrying (#n) ships the issue", async () => {
      // The spec commit and the body-only mention sit in v3.0.0; neither may
      // even be asked about (no `git tag` entry exists for them, so a lookup
      // would throw and surface as a failed-lookup note).
      const log = ["aaa111\tdocs(specs): design the thing (#8)", "bbb222\tfix(other): unrelated, cites #8 in its body", "ccc333\tfeat(actions): the thing (#8) (#9)"].join("\n");
      const tagged = { [timeline(8)]: "[]", [gitLog(8)]: `${log}\n` };

      expect(await one({}, { ...tagged, [gitTag("ccc333")]: "" })).toMatchObject({ expected: "Completed", version: null, note: null });
      expect(await one({}, { ...tagged, [gitTag("ccc333")]: "v3.1.0\n" })).toMatchObject({ expected: "Released", version: "v3.1.0", note: null });
    });

    it("reports an issue with no linked PR and no closing commit, and still proposes Completed", async () => {
      const row = await one({}, { [timeline(8)]: "[]", [gitLog(8)]: "" });

      expect(row).toMatchObject({ expected: "Completed", version: null, propose: true, note: "closed without a linked PR or closing commit; Released must be set by hand" });
    });

    it("takes the lowest stable version across every closing commit", async () => {
      const row = await one(
        { closedByPullRequestsReferences: [{ number: 91 }, { number: 92 }] },
        {
          [prView(91)]: JSON.stringify({ mergeCommit: { oid: "s91" } }),
          [prView(92)]: JSON.stringify({ mergeCommit: { oid: "s92" } }),
          [timeline(8)]: "[]",
          [gitLog(8)]: "",
          [gitTag("s91")]: "v3.3.0\n",
          [gitTag("s92")]: "v3.2.0\nv3.3.0\n",
        },
      );

      expect(row).toMatchObject({ expected: "Released", version: "v3.2.0" });
    });

    it("keeps a failing lookup to its own row", async () => {
      const list = [shipped(8, "Broken", { body: sourced("30"), closedByPullRequestsReferences: [{ number: 91 }] }), shipped(3, "Shipped", { body: sourced("10"), closedByPullRequestsReferences: [{ number: 33 }] })];
      const { rows } = await rowsFor(list, { ...shippedLookups, [prView(91)]: new Error("Command failed: gh pr view 91 --json mergeCommit\ngh: Not Found (HTTP 404)") });

      expect(rows[0]).toMatchObject({ expected: "Completed", version: null, propose: true, note: "release lookup failed: Command failed: gh pr view 91 --json mergeCommit" });
      expect(rows[1]).toMatchObject({ expected: "Released", version: "v3.2.0", propose: false, note: null });
    });
  });
});
