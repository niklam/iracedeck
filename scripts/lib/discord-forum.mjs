/**
 * Pure logic for the Discord feature-requests tooling (#1114): what a forum
 * post looks like once flattened, which of its tags is the status tag, and
 * which status tag a GitHub issue's state calls for. No IO here — the client
 * lives in `discord-api.mjs`, the commands in `discord-forum-commands.mjs`.
 *
 * Design record: docs/superpowers/specs/2026-09-04-issue-1114-discord-feature-requests-tracker.md
 */

/** The channel's lifecycle tags, in lifecycle order. Names are exact. */
export const STATUS_TAGS = Object.freeze(["Will Add", "In progress", "Completed", "Released", "Won't do"]);
export const WONT_DO = "Won't do";

/**
 * Posts that are never triaged, replied to, or re-tagged by this tool.
 * "[Race Engineer] Add your name" is the standing thread where people comment
 * to get a name added to the Race Engineer; it stays `Will Add` forever.
 */
export const STANDING_POST_IDS = Object.freeze(["1516472792260808724"]);

export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_EPOCH_MS = 1420070400000;

const STATUS_RANK = { "Will Add": 1, "In progress": 2, Completed: 3, Released: 4 };
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const POST_LINK = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)/;
const MAX_TAGS_PER_POST = 5;

/** @param {string} id */
export function snowflakeToDate(id) {
  return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

function bySnowflakeDesc(a, b) {
  const x = BigInt(a.id);
  const y = BigInt(b.id);

  if (x === y) return 0;

  return x > y ? -1 : 1;
}

/**
 * Merges the guild's active threads with the channel's archived pages into one
 * newest-first list of this channel's posts.
 */
export function mergePosts({ active, archivedPages, channelId }) {
  const seen = new Map();
  const inChannel = (t) => t.parent_id === channelId;

  for (const t of active.filter(inChannel)) seen.set(t.id, { ...t, archived: false });

  for (const page of archivedPages) {
    for (const t of (page.threads ?? []).filter(inChannel)) {
      if (!seen.has(t.id)) seen.set(t.id, { ...t, archived: true });
    }
  }

  return [...seen.values()].sort(bySnowflakeDesc);
}

export function tagNamesOf(appliedIds, availableTags) {
  const byId = new Map(availableTags.map((t) => [t.id, t.name]));

  return appliedIds.map((id) => byId.get(id) ?? id);
}

export function statusTagOf(tagNames) {
  return tagNames.find((name) => STATUS_TAGS.includes(name)) ?? null;
}

export function resolveStatusTag(name, availableTags) {
  if (!STATUS_TAGS.includes(name)) {
    throw new Error(`Unknown status tag "${name}". Valid: ${STATUS_TAGS.join(", ")}`);
  }

  const tag = availableTags.find((t) => t.name === name);

  if (!tag) {
    throw new Error(`Status tag "${name}" does not exist on the channel (its tags: ${availableTags.map((t) => t.name).join(", ")})`);
  }

  return tag;
}

/** Swaps the post's status tag for `newTag`, keeping every category tag. */
export function replaceStatusTag(appliedIds, newTag, availableTags) {
  const statusIds = new Set(availableTags.filter((t) => STATUS_TAGS.includes(t.name)).map((t) => t.id));
  const next = [...appliedIds.filter((id) => !statusIds.has(id)), newTag.id];

  if (next.length > MAX_TAGS_PER_POST) {
    throw new Error(`A post can carry at most ${MAX_TAGS_PER_POST} tags; this one would have ${next.length}`);
  }

  return next;
}

export function postLink(guildId, postId) {
  return `https://discord.com/channels/${guildId}/${postId}`;
}

export function parsePostLink(text) {
  const match = POST_LINK.exec(text ?? "");

  return match ? { guildId: match[1], postId: match[2] } : null;
}

export function describePost(thread, availableTags, guildId) {
  const tags = tagNamesOf(thread.applied_tags ?? [], availableTags);

  return {
    id: thread.id,
    title: thread.name,
    link: postLink(guildId, thread.id),
    created: snowflakeToDate(thread.id).toISOString(),
    archived: thread.thread_metadata?.archived ?? thread.archived ?? false,
    replies: thread.message_count ?? 0,
    ownerId: thread.owner_id,
    tags,
    statusTag: statusTagOf(tags),
    standing: STANDING_POST_IDS.includes(thread.id),
  };
}

export function sourceLine({ link, handle, votes }) {
  return `Requested on Discord: ${link} by ${handle} (${votes} ❤️)`;
}

export function summarizeReactions(message) {
  const breakdown = (message.reactions ?? []).map((r) => ({ name: r.emoji?.name ?? "?", count: r.count ?? 0 }));

  return { total: breakdown.reduce((sum, r) => sum + r.count, 0), breakdown };
}

/**
 * The follow-up table from the spec. `issue` is the `gh issue list --json`
 * shape: state, stateReason, assignees, milestone.
 */
export function expectedTag(issue, releasedVersion = null) {
  if (issue.state === "CLOSED") {
    if (issue.stateReason === "NOT_PLANNED") return WONT_DO;

    return releasedVersion ? "Released" : "Completed";
  }

  const inProgress = (issue.assignees?.length ?? 0) > 0 || Boolean(issue.milestone);

  return inProgress ? "In progress" : "Will Add";
}

export function rank(tag) {
  return tag ? (STATUS_RANK[tag] ?? 0) : 0;
}

/** Forward moves only; Won't do is reachable from anywhere and terminal. */
export function shouldPropose(current, expected) {
  if (current === expected) return false;
  if (expected === WONT_DO) return true;
  if (current === WONT_DO) return false;

  return rank(expected) > rank(current);
}

/** Lowest `vX.Y.Z` among tag names; pre-releases never count as shipped. */
export function lowestStableVersion(tagNames) {
  const stable = tagNames
    .map((name) => STABLE_TAG.exec(name))
    .filter(Boolean)
    .map((m) => ({ name: m[0], parts: m.slice(1).map(Number) }))
    .sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2]);

  return stable[0]?.name ?? null;
}
