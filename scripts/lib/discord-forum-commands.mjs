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
  mergePosts,
  postLink,
  replaceStatusTag,
  resolveStatusTag,
  STANDING_POST_IDS,
  summarizeReactions,
  tagNamesOf,
} from "./discord-forum.mjs";

export const REQUIRED_ENV = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_FEATURE_REQUESTS_CHANNEL_ID"];

const PAGE = 100;
const MAX_ARCHIVED_PAGES = 20;
const MAX_MESSAGE_PAGES = 10;

/** @returns {{ token: string, guildId: string, channelId: string } | { error: string }} */
export function readConfig(root, env = process.env) {
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

/** Active threads (guild-wide, filtered) plus every archived page of the channel. */
export async function fetchAllPosts(client, { guildId, channelId }) {
  const active = (await client.get(`/guilds/${guildId}/threads/active`)).threads ?? [];
  const archivedPages = [];
  let before = null;

  for (let page = 0; page < MAX_ARCHIVED_PAGES; page += 1) {
    const query = before ? `?limit=${PAGE}&before=${encodeURIComponent(before)}` : `?limit=${PAGE}`;
    const result = await client.get(`/channels/${channelId}/threads/archived/public${query}`);
    archivedPages.push(result);

    if (!result.has_more || !result.threads?.length) break;

    before = result.threads.at(-1).thread_metadata?.archive_timestamp;

    if (!before) break;
  }

  return mergePosts({ active, archivedPages, channelId });
}

/** Every message in a post, oldest first. Discord pages newest-first on `before`. */
export async function fetchPostMessages(client, postId) {
  const all = [];
  let before = null;

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const query = before ? `?limit=${PAGE}&before=${before}` : `?limit=${PAGE}`;
    const batch = await client.get(`/channels/${postId}/messages${query}`);
    all.push(...batch);

    if (batch.length < PAGE) break;

    before = batch.at(-1).id;
  }

  return all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
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
  const starter = messages.find((m) => m.id === postId) ?? messages[0];
  const post = {
    ...describePost(thread, tags, config.guildId),
    author: { id: starter.author.id, handle: starter.author.username },
    votes: summarizeReactions(starter),
    starter: { id: starter.id, createdAt: starter.timestamp, content: starter.content },
    replies: messages
      .filter((m) => m.id !== starter.id)
      .map((m) => ({ id: m.id, author: m.author.username, createdAt: m.timestamp, content: m.content })),
  };

  if (json) {
    log.log(JSON.stringify(post, null, 2));

    return 0;
  }

  log.log(`${post.title}`);
  log.log(`${post.link}`);
  log.log(`by ${post.author.handle} on ${post.created.slice(0, 10)}  tags=[${post.tags.join(", ")}]  ${post.archived ? "archived" : "active"}`);
  log.log(`votes: ${post.votes.total}${post.votes.breakdown.length ? ` (${post.votes.breakdown.map((r) => `${r.name} ${r.count}`).join(", ")})` : ""}`);
  log.log("");
  log.log(post.starter.content);

  for (const reply of post.replies) {
    log.log("");
    log.log(`--- ${reply.author}, ${reply.createdAt.slice(0, 16).replace("T", " ")} ---`);
    log.log(reply.content);
  }

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
