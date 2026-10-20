/**
 * The commands behind `scripts/discord/forum.mjs` (#1114, #1460). Every
 * function takes injected `config` / `client` / `log` (and `exec` for the
 * GitHub side) and returns a process exit code — the entry file owns
 * termination, and the tests own the client. `config.forum` names the forum
 * profile (`discord-forums.mjs`) that `list`, `show`, `reply` and `tag` act
 * on; `follow-up` covers every forum in `config.channels`.
 *
 * Design records: docs/superpowers/specs/2026-09-04-issue-1114-discord-feature-requests-tracker.md
 * and docs/superpowers/specs/2026-10-18-issue-1460-discord-bugs-forum.md
 */
import {
  describePost,
  DISCORD_MESSAGE_LIMIT,
  lowestStableVersion,
  mergePosts,
  parseSourceLine,
  postLink,
  replaceStatusTag,
  resolveStatusTag,
  sourceLine,
  STANDING_POST_IDS,
  summarizeReactions,
  tagNamesOf,
} from "./discord-forum.mjs";
import { DEFAULT_FORUM, forumProfile, FORUMS } from "./discord-forums.mjs";
import { loadEnvLocal } from "./env-local.mjs";

/** Needed by every forum; each forum adds its own channel variable. */
const SHARED_ENV = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"];

const PAGE = 100;
const MAX_ARCHIVED_PAGES = 20;
const MAX_MESSAGE_PAGES = 10;

/**
 * Reads the token, the guild and the selected forum's channel from `env`,
 * filling gaps from `.env.local`. `env` defaults to a COPY of the process
 * environment: the token read from the file must never land in
 * `process.env`, where every child process (gh, git) would inherit it. A
 * shell-exported value still wins over the file.
 *
 * Only the SELECTED forum's channel is required, so a machine without
 * `DISCORD_BUGS_CHANNEL_ID` keeps using feature-requests. `channelId` is the
 * selected forum's; `channels` maps every forum whose variable is set to its
 * channel, for `follow-up`, which covers them all. `forumName` `null` selects
 * no forum — `follow-up`'s case — and then any one channel will do, so
 * `pnpm discord:bugs follow-up` still checks feature-requests on a machine
 * without the bugs channel; `forum` and `channelId` are `null` then.
 *
 * @returns {{ token: string, guildId: string, forum: string | null, channelId: string | null, channels: Record<string, string> } | { error: string }}
 */
export function readConfig(root, env = { ...process.env }, forumName = DEFAULT_FORUM) {
  const forum = forumName === null ? null : forumProfile(forumName);
  loadEnvLocal(root, env);
  const missing = SHARED_ENV.filter((name) => !env[name]);

  if (forum && !env[forum.channelEnv]) missing.push(forum.channelEnv);

  const profiles = Object.values(FORUMS);

  if (!forum && !profiles.some((profile) => env[profile.channelEnv])) {
    missing.push(`one of ${profiles.map((profile) => profile.channelEnv).join(" / ")}`);
  }

  if (missing.length > 0) {
    return {
      error: `Missing ${missing.join(", ")} — set them in .env.local at the repo root (see .env.local.example).`,
    };
  }

  const channels = Object.fromEntries(
    profiles.filter((profile) => env[profile.channelEnv]).map((profile) => [profile.name, env[profile.channelEnv]]),
  );

  return {
    token: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    forum: forum?.name ?? null,
    channelId: forum ? env[forum.channelEnv] : null,
    channels,
  };
}

/** The profile of the forum `config` selected. */
function forumOf(config) {
  return forumProfile(config.forum ?? DEFAULT_FORUM);
}

export async function fetchTags(client, channelId) {
  const channel = await client.get(`/channels/${channelId}`);

  return channel.available_tags ?? [];
}

/** Every active thread in the guild, in any channel; `mergePosts` filters to one. */
export async function fetchActiveThreads(client, guildId) {
  return (await client.get(`/guilds/${guildId}/threads/active`)).threads ?? [];
}

/**
 * Active threads (guild-wide, filtered) plus every archived page of the
 * channel. The page caps fail loud: a silently truncated listing would make
 * `follow-up` report old posts as missing and `list` hide them.
 */
export async function fetchAllPosts(client, { guildId, channelId }, active = null) {
  // `active` is the guild-wide list, which `follow-up` fetches once for every
  // forum rather than once per forum.
  active ??= await fetchActiveThreads(client, guildId);
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

  throw new Error(
    `archived-thread listing truncated after ${MAX_ARCHIVED_PAGES} pages; raise MAX_ARCHIVED_PAGES or report this`,
  );
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

  // Per forum: an id pasted from the other forum is never read, replied to or
  // tagged as if it were this one's.
  if (thread.parent_id !== config.channelId) {
    log.error(`Error: ${postId} is not a post in the ${forumOf(config).label}.`);

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
  const { statusTags } = forumOf(config);
  const tags = await fetchTags(client, config.channelId);
  let posts = (await fetchAllPosts(client, config)).map((thread) =>
    describePost(thread, tags, config.guildId, statusTags),
  );

  if (untagged) posts = posts.filter((post) => post.statusTag === null && !post.standing);

  if (json) {
    log.log(JSON.stringify(posts, null, 2));
  } else {
    for (const post of posts) log.log(formatListRow(post));
  }

  return 0;
}

export async function runShow({ postId, json = false }, { config, client, log = console }) {
  const forum = forumOf(config);
  const tags = await fetchTags(client, config.channelId);
  const thread = await fetchPostThread(client, config, postId, log);

  if (!thread) return 1;

  const messages = await fetchPostMessages(client, postId);
  // A forum post's starter message shares the thread's id. When it has been
  // deleted nothing may stand in for it: the oldest reply is not the request,
  // its author is not the requester, and its reactions are not votes — and
  // `show --json` is what the issue's "Requested on Discord … by" line credits.
  const starter = messages.find((m) => m.id === postId) ?? null;
  const described = describePost(thread, tags, config.guildId, forum.statusTags);
  const author = starter
    ? { id: starter.author.id, handle: starter.author.username }
    : { id: thread.owner_id, handle: null };
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
    sourceLine: sourceLine({
      link: described.link,
      handle: author.handle ?? "unknown",
      votes: votes.total,
      verb: forum.sourceVerb,
    }),
  };

  if (json) {
    log.log(JSON.stringify(post, null, 2));

    return 0;
  }

  log.log(`${post.title}`);
  log.log(`${post.link}`);
  log.log(
    `by ${post.author.handle ?? "(unknown)"} on ${post.created.slice(0, 10)}  tags=[${post.tags.join(", ")}]  ${post.archived ? "archived" : "active"}`,
  );
  log.log(
    `votes: ${post.votes.total}${post.votes.breakdown.length ? ` (${post.votes.breakdown.map((r) => `${r.name} ${r.count}`).join(", ")})` : ""}`,
  );
  log.log("");
  log.log(
    post.starter ? post.starter.content : "(The original message was deleted; its author and votes are unknown.)",
  );

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
  const { statusTags } = forumOf(config);
  const tags = await fetchTags(client, config.channelId);
  let tag;

  try {
    tag = resolveStatusTag(tagName, tags, statusTags);
  } catch (error) {
    log.error(`Error: ${error.message}`);

    return 1;
  }

  const thread = await fetchPostThread(client, config, postId, log, { forWrite: true });

  if (!thread) return 1;

  let applied;

  try {
    applied = replaceStatusTag(thread.applied_tags ?? [], tag, tags, statusTags);
  } catch (error) {
    log.error(`Error: ${error.message}`);

    return 1;
  }

  // Discord refuses edits to an archived thread; a status change is activity,
  // so un-archiving in the same request is the honest thing to do.
  const body = thread.thread_metadata?.archived
    ? { applied_tags: applied, archived: false }
    : { applied_tags: applied };
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
/**
 * The commits named by an issue's timeline `closed` events (null when a PR,
 * not a commit, closed it), emitted one raw sha per line. `gh api --paginate
 * --jq` runs the filter once PER PAGE and concatenates the outputs, so a
 * filter that built an array would yield one array per page and break a
 * single `JSON.parse` on a timeline longer than 100 events; lines survive
 * any page boundary.
 */
const CLOSING_COMMITS_JQ = '.[] | select(.event == "closed") | .commit_id | select(. != null)';
/** `gh issue list` needs an explicit cap; hitting it means the listing is incomplete. */
const ISSUE_LIMIT = 500;
const noClosingCommitNote = (forum) =>
  `closed without a linked PR or closing commit; ${forum.releasedTag} must be set by hand`;

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

  for (const sha of lines(
    exec("gh", [
      "api",
      `repos/{owner}/{repo}/issues/${issue.number}/timeline`,
      "--paginate",
      "--jq",
      CLOSING_COMMITS_JQ,
    ]),
  ))
    shas.add(sha);

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
function releasedVersionOf(exec, issue, forum) {
  try {
    const shas = shippingCommitsOf(exec, issue);

    if (shas.length === 0) return { version: null, note: noClosingCommitNote(forum) };

    const tags = shas.flatMap((sha) => lines(exec("git", ["tag", "--contains", sha])));

    return { version: lowestStableVersion(tags), note: null };
  } catch (error) {
    return { version: null, note: `release lookup failed: ${lines(String(error.message))[0] ?? "unknown error"}` };
  }
}

/**
 * The note for a source line whose post is in none of the forums fetched. It
 * names every forum searched, and every forum NOT searched because its channel
 * variable is unset — a post missing from a forum nobody looked in is not
 * missing.
 */
function notFoundNote(postId, searched, unconfigured) {
  const where = searched.map((forum) => `the ${forum.label}`).join(" or ");
  const unsearched = unconfigured.map((forum) => `; the ${forum.label} is not configured (${forum.channelEnv})`);

  return `post ${postId} not found in ${where}${unsearched.join("")}`;
}

/**
 * One follow-up row. A row whose post was not found has no forum, so no tag
 * vocabulary applies to it: its `expected` is `null`. Once the post is found,
 * that forum's profile decides the expected tag, the proposal and the note.
 */
function followUpRow(issue, { config, postsById, exec, notFound }) {
  const base = {
    issue: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    forum: null,
    post: null,
    current: null,
    expected: null,
    version: null,
    propose: false,
    note: null,
  };
  const source = parseSourceLine(issue.body);

  if (!source) return { ...base, note: "no source line in the issue body" };
  if (source.guildId !== config.guildId) return { ...base, note: "source line points at another server" };

  const found = postsById.get(source.postId);

  if (!found) return { ...base, note: notFound(source.postId) };

  const { post, forum } = found;
  const row = {
    ...base,
    forum: forum.name,
    // `archived` is shown because tagging an archived thread unarchives it, so
    // the maintainer leaves one alone unless it needs a reply.
    post: { id: post.id, title: post.title, link: post.link, archived: post.archived },
    current: post.statusTag,
    expected: forum.expectedTag(issue),
  };

  if (post.standing) return { ...row, note: "standing post; never changed by this tool" };

  // Only a completed issue can have shipped, and only a row that may still
  // change is worth the gh/git round trips.
  const release =
    issue.state === "CLOSED" && issue.stateReason === "COMPLETED"
      ? releasedVersionOf(exec, issue, forum)
      : { version: null, note: null };
  const expected = forum.expectedTag(issue, release.version);

  return {
    ...row,
    expected,
    version: release.version,
    propose: forum.shouldPropose(post.statusTag, expected),
    // A lookup's own note wins; otherwise a null tag is explained only where
    // the profile says it needs explaining (an open bug's does not).
    note: release.note ?? (expected === null ? forum.noTagNote(issue) : null),
  };
}

function formatFollowUpRow(row) {
  const move = `${row.current ?? "none"} -> ${row.expected ?? "none"}${row.version ? ` (${row.version})` : ""}`;
  // A row with no post has nothing to be up to date with.
  const verdict = row.propose ? "PROPOSE" : row.post && row.current === row.expected ? "up to date" : "no change";
  const note = row.note ? `  (note: ${row.note})` : "";
  const post = row.post ? `[${row.forum}] ${row.post.title}${row.post.archived ? " (archived)" : ""}` : "(no post)";

  return `#${row.issue} ${row.title}\n    ${post}\n    ${move}  ${verdict}${note}`;
}

/**
 * The reconciliation half of the follow-up run: what each Discord-sourced
 * issue's post carries versus what its GitHub state calls for. Covers every
 * forum in `config.channels` in one run, whichever forum `config` selected:
 * each source line's post is looked up across all of them, and the profile of
 * the forum it is found in applies. Proposes; never sends. `exec(file, args)`
 * returns stdout, so the GitHub side is fakeable.
 */
export async function runFollowUp({ json = false }, { config, client, log = console, exec }) {
  const issues = gh(exec, [
    "issue",
    "list",
    "--label",
    "discord",
    "--state",
    "all",
    "--limit",
    String(ISSUE_LIMIT),
    "--json",
    ISSUE_FIELDS,
  ]);

  if (issues.length >= ISSUE_LIMIT) {
    throw new Error(`discord-labelled issue listing truncated at ${ISSUE_LIMIT}; raise ISSUE_LIMIT or report this`);
  }

  exec("git", ["fetch", "--tags", "--quiet"]);

  const searched = Object.values(FORUMS).filter((forum) => config.channels[forum.name]);
  const unconfigured = Object.values(FORUMS).filter((forum) => !config.channels[forum.name]);
  // A post id is a thread id, so it is in at most one channel.
  const postsById = new Map();
  const active = await fetchActiveThreads(client, config.guildId);

  for (const forum of searched) {
    const channelId = config.channels[forum.name];
    const tags = await fetchTags(client, channelId);

    for (const thread of await fetchAllPosts(client, { guildId: config.guildId, channelId }, active)) {
      postsById.set(thread.id, { post: describePost(thread, tags, config.guildId, forum.statusTags), forum });
    }
  }

  const notFound = (postId) => notFoundNote(postId, searched, unconfigured);
  const rows = issues.map((issue) => followUpRow(issue, { config, postsById, exec, notFound }));

  if (json) {
    log.log(JSON.stringify(rows, null, 2));

    return 0;
  }

  for (const forum of unconfigured) {
    log.log(`Note: the ${forum.label} is not configured (${forum.channelEnv}); its posts are not checked.`);
  }

  if (unconfigured.length > 0) log.log("");

  for (const row of rows) log.log(formatFollowUpRow(row));

  const proposed = rows.filter((row) => row.propose).length;
  log.log("");
  log.log(`${rows.length} Discord-sourced issues, ${proposed} proposed change${proposed === 1 ? "" : "s"}.`);

  return 0;
}
