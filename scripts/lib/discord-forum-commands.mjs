/**
 * The commands behind `scripts/discord/feature-requests.mjs` (#1114). Every
 * function takes injected `config` / `client` / `log` (and `exec` for the
 * GitHub side) and returns a process exit code — the entry file owns
 * termination, and the tests own the client.
 *
 * Design record: docs/superpowers/specs/2026-09-04-issue-1114-discord-feature-requests-tracker.md
 */
import { loadEnvLocal } from "./env-local.mjs";
import {
  describePost,
  DISCORD_MESSAGE_LIMIT,
  expectedTag,
  lowestStableVersion,
  mergePosts,
  parseSourceLine,
  postLink,
  replaceStatusTag,
  resolveStatusTag,
  shouldPropose,
  sourceLine,
  STANDING_POST_IDS,
  summarizeReactions,
  tagNamesOf,
} from "./discord-forum.mjs";

export const REQUIRED_ENV = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_FEATURE_REQUESTS_CHANNEL_ID"];

const PAGE = 100;
const MAX_ARCHIVED_PAGES = 20;
const MAX_MESSAGE_PAGES = 10;

/**
 * Reads the three variables from `env`, filling gaps from `.env.local`.
 * `env` defaults to a COPY of the process environment: the token read from
 * the file must never land in `process.env`, where every child process (gh,
 * git) would inherit it. A shell-exported value still wins over the file.
 *
 * @returns {{ token: string, guildId: string, channelId: string } | { error: string }}
 */
export function readConfig(root, env = { ...process.env }) {
  loadEnvLocal(root, env);
  const missing = REQUIRED_ENV.filter((name) => !env[name]);

  if (missing.length > 0) {
    return { error: `Missing ${missing.join(", ")} — set them in .env.local at the repo root (see .env.local.example).` };
  }

  return { token: env.DISCORD_BOT_TOKEN, guildId: env.DISCORD_GUILD_ID, channelId: env.DISCORD_FEATURE_REQUESTS_CHANNEL_ID };
}

export async function fetchTags(client, channelId) {
  const channel = await client.get(`/channels/${channelId}`);

  return channel.available_tags ?? [];
}

/**
 * Active threads (guild-wide, filtered) plus every archived page of the
 * channel. The page caps fail loud: a silently truncated listing would make
 * `follow-up` report old posts as missing and `list` hide them.
 */
export async function fetchAllPosts(client, { guildId, channelId }) {
  const active = (await client.get(`/guilds/${guildId}/threads/active`)).threads ?? [];
  const archivedPages = [];
  let before = null;

  for (let page = 0; page < MAX_ARCHIVED_PAGES; page += 1) {
    const query = before ? `?limit=${PAGE}&before=${encodeURIComponent(before)}` : `?limit=${PAGE}`;
    const result = await client.get(`/channels/${channelId}/threads/archived/public${query}`);
    archivedPages.push(result);

    if (!result.has_more) return mergePosts({ active, archivedPages, channelId });

    before = result.threads?.at(-1)?.thread_metadata?.archive_timestamp;

    if (!before) throw new Error("archived-thread listing cannot page further: last thread has no archive_timestamp");
  }

  throw new Error(`archived-thread listing truncated after ${MAX_ARCHIVED_PAGES} pages; raise MAX_ARCHIVED_PAGES or report this`);
}

/** Every message in a post, oldest first. Discord pages newest-first on `before`. */
export async function fetchPostMessages(client, postId) {
  const all = [];
  let before = null;

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const query = before ? `?limit=${PAGE}&before=${before}` : `?limit=${PAGE}`;
    const batch = await client.get(`/channels/${postId}/messages${query}`);
    all.push(...batch);

    if (batch.length < PAGE) return all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

    before = batch.at(-1).id;
  }

  throw new Error(`post has more than ${MAX_MESSAGE_PAGES * PAGE} messages; raise MAX_MESSAGE_PAGES`);
}

async function fetchPostThread(client, config, postId, log, { forWrite = false } = {}) {
  if (forWrite && STANDING_POST_IDS.includes(postId)) {
    log.error(`Error: ${postId} is a standing post; this tool never writes to it.`);

    return null;
  }

  const thread = await client.get(`/channels/${postId}`);

  if (thread.parent_id !== config.channelId) {
    log.error(`Error: ${postId} is not a post in the feature-requests channel.`);

    return null;
  }

  return thread;
}

function formatListRow(post) {
  const state = post.archived ? "archived" : "active  ";
  const replies = String(post.replies).padStart(2);

  return `${post.id}  ${state}  ${post.created.slice(0, 10)}  replies=${replies}  [${post.tags.join(", ")}]  ${post.title}`;
}

export async function runList({ untagged = false, json = false }, { config, client, log = console }) {
  const tags = await fetchTags(client, config.channelId);
  let posts = (await fetchAllPosts(client, config)).map((thread) => describePost(thread, tags, config.guildId));

  if (untagged) posts = posts.filter((post) => post.statusTag === null && !post.standing);

  if (json) {
    log.log(JSON.stringify(posts, null, 2));
  } else {
    for (const post of posts) log.log(formatListRow(post));
  }

  return 0;
}

export async function runShow({ postId, json = false }, { config, client, log = console }) {
  const tags = await fetchTags(client, config.channelId);
  const thread = await fetchPostThread(client, config, postId, log);

  if (!thread) return 1;

  const messages = await fetchPostMessages(client, postId);
  // A forum post's starter message shares the thread's id. When it has been
  // deleted nothing may stand in for it: the oldest reply is not the request,
  // its author is not the requester, and its reactions are not votes — and
  // `show --json` is what the issue's "Requested on Discord … by" line credits.
  const starter = messages.find((m) => m.id === postId) ?? null;
  const described = describePost(thread, tags, config.guildId);
  const author = starter ? { id: starter.author.id, handle: starter.author.username } : { id: thread.owner_id, handle: null };
  const votes = starter ? summarizeReactions(starter) : { total: 0, breakdown: [] };
  const post = {
    ...described,
    author,
    votes,
    starter: starter ? { id: starter.id, createdAt: starter.timestamp, content: starter.content } : null,
    replies: messages
      .filter((m) => m.id !== postId)
      .map((m) => ({ id: m.id, author: m.author.username, createdAt: m.timestamp, content: m.content })),
    // The line the issue carries back to this post, ready to paste verbatim;
    // `follow-up` parses exactly this shape.
    sourceLine: sourceLine({ link: described.link, handle: author.handle ?? "unknown", votes: votes.total }),
  };

  if (json) {
    log.log(JSON.stringify(post, null, 2));

    return 0;
  }

  log.log(`${post.title}`);
  log.log(`${post.link}`);
  log.log(`by ${post.author.handle ?? "(unknown)"} on ${post.created.slice(0, 10)}  tags=[${post.tags.join(", ")}]  ${post.archived ? "archived" : "active"}`);
  log.log(`votes: ${post.votes.total}${post.votes.breakdown.length ? ` (${post.votes.breakdown.map((r) => `${r.name} ${r.count}`).join(", ")})` : ""}`);
  log.log("");
  log.log(post.starter ? post.starter.content : "(The original message was deleted; its author and votes are unknown.)");

  for (const reply of post.replies) {
    log.log("");
    log.log(`--- ${reply.author}, ${reply.createdAt.slice(0, 16).replace("T", " ")} ---`);
    log.log(reply.content);
  }

  log.log("");
  log.log(`source line: ${post.sourceLine}`);

  return 0;
}

function printDryRun(log, method, path, body) {
  log.log(`DRY RUN — would ${method} ${path} with:`);
  log.log(JSON.stringify(body, null, 2));
}

export async function runReply({ postId, text, dryRun = false }, { config, client, log = console }) {
  if (!text || !text.trim()) {
    log.error("Error: reply text is empty.");

    return 1;
  }

  if (text.length > DISCORD_MESSAGE_LIMIT) {
    log.error(`Error: reply is ${text.length} characters; Discord's limit is ${DISCORD_MESSAGE_LIMIT}. Shorten it.`);

    return 1;
  }

  const thread = await fetchPostThread(client, config, postId, log, { forWrite: true });

  if (!thread) return 1;

  // No pings, ever: nothing the maintainer approves can @mention a role or
  // everyone by accident. The post's followers are notified by Discord anyway.
  const body = { content: text, allowed_mentions: { parse: [] } };
  const path = `/channels/${postId}/messages`;

  if (dryRun) {
    printDryRun(log, "POST", path, body);

    return 0;
  }

  const message = await client.post(path, body);
  log.log(`Posted: ${postLink(config.guildId, postId)}/${message.id}`);

  return 0;
}

export async function runTag({ postId, tagName, dryRun = false }, { config, client, log = console }) {
  const tags = await fetchTags(client, config.channelId);
  let tag;

  try {
    tag = resolveStatusTag(tagName, tags);
  } catch (error) {
    log.error(`Error: ${error.message}`);

    return 1;
  }

  const thread = await fetchPostThread(client, config, postId, log, { forWrite: true });

  if (!thread) return 1;

  let applied;

  try {
    applied = replaceStatusTag(thread.applied_tags ?? [], tag, tags);
  } catch (error) {
    log.error(`Error: ${error.message}`);

    return 1;
  }

  // Discord refuses edits to an archived thread; a status change is activity,
  // so un-archiving in the same request is the honest thing to do.
  const body = thread.thread_metadata?.archived ? { applied_tags: applied, archived: false } : { applied_tags: applied };
  const path = `/channels/${postId}`;

  if (dryRun) {
    printDryRun(log, "PATCH", path, body);

    return 0;
  }

  const updated = await client.patch(path, body);
  log.log(`Tagged "${thread.name}": [${tagNamesOf(updated.applied_tags ?? applied, tags).join(", ")}]`);

  return 0;
}

const ISSUE_FIELDS = "number,title,url,state,stateReason,assignees,milestone,body,closedByPullRequestsReferences";
/** The commits named by an issue's timeline `closed` events (null when a PR, not a commit, closed it). */
const CLOSING_COMMITS_JQ = '[.[] | select(.event == "closed") | .commit_id] | map(select(. != null))';
const NO_CLOSING_COMMIT_NOTE = "closed without a linked PR or closing commit; Released must be set by hand";

function gh(exec, args) {
  return JSON.parse(exec("gh", args));
}

function lines(output) {
  return output.split(/\r?\n/).filter(Boolean);
}

/**
 * Every commit that shipped the issue, from three sources in union: the
 * merge commits of the PRs GitHub links as closing it, the commit a timeline
 * `closed` event names, and squash-merge subjects carrying `(#n)`. The last
 * is filtered to the SUBJECT — `git log --grep` matches the whole message, so
 * a commit whose body cites the issue would otherwise count — and excludes
 * `docs(specs)` commits, whose subjects carry the issue number by convention
 * while shipping nothing (they land on master long before the feature, often
 * in an earlier release).
 */
function shippingCommitsOf(exec, issue) {
  const shas = new Set();

  for (const ref of issue.closedByPullRequestsReferences ?? []) {
    const sha = gh(exec, ["pr", "view", String(ref.number), "--json", "mergeCommit"]).mergeCommit?.oid;

    if (sha) shas.add(sha);
  }

  for (const sha of gh(exec, ["api", `repos/{owner}/{repo}/issues/${issue.number}/timeline`, "--paginate", "--jq", CLOSING_COMMITS_JQ])) shas.add(sha);

  const marker = `(#${issue.number})`;

  for (const line of lines(exec("git", ["log", "--all", "--fixed-strings", `--grep=${marker}`, "--format=%H%x09%s"]))) {
    const [sha, subject = ""] = line.split("\t");

    if (subject.includes(marker) && !subject.startsWith("docs(specs)")) shas.add(sha);
  }

  return [...shas];
}

/**
 * The lowest stable tag containing any of the issue's shipping commits. A
 * lookup that finds no commit, or fails, yields no version and a note; the
 * caller still derives the row from the issue's state, so one broken `gh`
 * call never hides the whole follow-up.
 *
 * @returns {{ version: string | null, note: string | null }}
 */
function releasedVersionOf(exec, issue) {
  try {
    const shas = shippingCommitsOf(exec, issue);

    if (shas.length === 0) return { version: null, note: NO_CLOSING_COMMIT_NOTE };

    const tags = shas.flatMap((sha) => lines(exec("git", ["tag", "--contains", sha])));

    return { version: lowestStableVersion(tags), note: null };
  } catch (error) {
    return { version: null, note: `release lookup failed: ${lines(String(error.message))[0] ?? "unknown error"}` };
  }
}

function followUpRow(issue, { config, postsById, exec }) {
  const base = { issue: issue.number, title: issue.title, url: issue.url, state: issue.state, post: null, current: null, expected: expectedTag(issue), version: null, propose: false, note: null };
  const source = parseSourceLine(issue.body);

  if (!source) return { ...base, note: "no source line in the issue body" };
  if (source.guildId !== config.guildId) return { ...base, note: "source line points at another server" };

  const post = postsById.get(source.postId);

  if (!post) return { ...base, note: `post ${source.postId} not found in the channel` };

  const row = { ...base, post: { id: post.id, title: post.title, link: post.link }, current: post.statusTag };

  if (post.standing) return { ...row, note: "standing post; never changed by this tool" };
  if (row.expected === null) return { ...row, note: "closed as duplicate; point the post at the canonical issue by hand" };

  // Only a completed issue can have shipped, and only a row that may still
  // change is worth the gh/git round trips.
  const release = issue.state === "CLOSED" && issue.stateReason === "COMPLETED" ? releasedVersionOf(exec, issue) : { version: null, note: null };
  const expected = expectedTag(issue, release.version);

  return { ...row, expected, version: release.version, propose: shouldPropose(post.statusTag, expected), note: release.note };
}

function formatFollowUpRow(row) {
  const move = `${row.current ?? "none"} -> ${row.expected ?? "none"}${row.version ? ` (${row.version})` : ""}`;
  const verdict = row.propose ? "PROPOSE" : row.current === row.expected ? "up to date" : "no change";
  const note = row.note ? `  (note: ${row.note})` : "";
  const post = row.post ? row.post.title : "(no post)";

  return `#${row.issue} ${row.title}\n    ${post}\n    ${move}  ${verdict}${note}`;
}

/**
 * The reconciliation half of the follow-up run: what each Discord-sourced
 * issue's post carries versus what its GitHub state calls for. Proposes; never
 * sends. `exec(file, args)` returns stdout, so the GitHub side is fakeable.
 */
export async function runFollowUp({ json = false }, { config, client, log = console, exec }) {
  const issues = gh(exec, ["issue", "list", "--label", "discord", "--state", "all", "--limit", "500", "--json", ISSUE_FIELDS]);
  exec("git", ["fetch", "--tags", "--quiet"]);

  const tags = await fetchTags(client, config.channelId);
  const posts = (await fetchAllPosts(client, config)).map((thread) => describePost(thread, tags, config.guildId));
  const postsById = new Map(posts.map((post) => [post.id, post]));
  const rows = issues.map((issue) => followUpRow(issue, { config, postsById, exec }));

  if (json) {
    log.log(JSON.stringify(rows, null, 2));

    return 0;
  }

  for (const row of rows) log.log(formatFollowUpRow(row));

  const proposed = rows.filter((row) => row.propose).length;
  log.log("");
  log.log(`${rows.length} Discord-sourced issues, ${proposed} proposed change${proposed === 1 ? "" : "s"}.`);

  return 0;
}
