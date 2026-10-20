/**
 * Pure logic for the Discord forum tooling (#1114, #1460): what a forum post
 * looks like once flattened, which of its tags is the status tag, and which
 * status tag a GitHub issue's state calls for in each forum. No IO here — the
 * client lives in `discord-api.mjs`, the commands in
 * `discord-forum-commands.mjs`, and the per-forum profiles that choose among
 * these functions in `discord-forums.mjs`, which imports this file and never
 * the other way round.
 *
 * Design records: docs/superpowers/specs/2026-09-04-issue-1114-discord-feature-requests-tracker.md
 * and docs/superpowers/specs/2026-10-18-issue-1460-discord-bugs-forum.md
 */
import { compare, prerelease, valid } from "semver";

/** The feature-requests forum's lifecycle tags, in lifecycle order. Names are exact. */
export const STATUS_TAGS = Object.freeze(["Will Add", "In progress", "Completed", "Released", "Won't do"]);
export const WONT_DO = "Won't do";
/** The #bugs forum's one status tag: the fix is in a stable release. */
export const RESOLVED = "Resolved";
export const BUG_STATUS_TAGS = Object.freeze([RESOLVED]);

/**
 * Posts that are never triaged, replied to, or re-tagged by this tool.
 * "[Race Engineer] Add your name" is the standing thread where people comment
 * to get a name added to the Race Engineer; it stays `Will Add` forever.
 */
export const STANDING_POST_IDS = Object.freeze(["1516472792260808724"]);

export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_EPOCH_MS = 1420070400000;

const STATUS_RANK = { "Will Add": 1, "In progress": 2, Completed: 3, Released: 4 };
/**
 * The line an issue body carries back to its post (see `sourceLine`). Anchored
 * to the start of its own line: an issue body can cite other Discord URLs, and
 * the first one found is not the post the issue came from. One shape for both
 * forums, so one parser: `Requested` for a feature request, `Reported` for a
 * bug, and no other verb.
 */
const SOURCE_LINE = /^(?:Requested|Reported) on Discord: https:\/\/discord\.com\/channels\/(\d+)\/(\d+)/m;
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

/*
 * `statusTags` below is the forum profile's tag list. The default is the
 * feature-requests list, kept for the #1114 callers; every command passes its
 * forum's list explicitly.
 */

export function statusTagOf(tagNames, statusTags = STATUS_TAGS) {
  return tagNames.find((name) => statusTags.includes(name)) ?? null;
}

export function resolveStatusTag(name, availableTags, statusTags = STATUS_TAGS) {
  if (!statusTags.includes(name)) {
    throw new Error(`Unknown status tag "${name}". Valid: ${statusTags.join(", ")}`);
  }

  const tag = availableTags.find((t) => t.name === name);

  if (!tag) {
    throw new Error(
      `Status tag "${name}" does not exist on the channel (its tags: ${availableTags.map((t) => t.name).join(", ")})`,
    );
  }

  return tag;
}

/** Swaps the post's status tag for `newTag`, keeping every category tag. */
export function replaceStatusTag(appliedIds, newTag, availableTags, statusTags = STATUS_TAGS) {
  const statusIds = new Set(availableTags.filter((t) => statusTags.includes(t.name)).map((t) => t.id));
  const next = [...appliedIds.filter((id) => !statusIds.has(id)), newTag.id];

  if (next.length > MAX_TAGS_PER_POST) {
    throw new Error(`A post can carry at most ${MAX_TAGS_PER_POST} tags; this one would have ${next.length}`);
  }

  return next;
}

export function postLink(guildId, postId) {
  return `https://discord.com/channels/${guildId}/${postId}`;
}

/** @returns {{ guildId: string, postId: string } | null} the source line's post, if the body has one */
export function parseSourceLine(text) {
  const match = SOURCE_LINE.exec(text ?? "");

  return match ? { guildId: match[1], postId: match[2] } : null;
}

export function describePost(thread, availableTags, guildId, statusTags = STATUS_TAGS) {
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
    statusTag: statusTagOf(tags, statusTags),
    standing: STANDING_POST_IDS.includes(thread.id),
  };
}

/** `verb` is the forum profile's: `Requested` for a feature request, `Reported` for a bug. */
export function sourceLine({ link, handle, votes, verb = "Requested" }) {
  return `${verb} on Discord: ${link} by ${handle} (${votes} ❤️)`;
}

export function summarizeReactions(message) {
  const breakdown = (message.reactions ?? []).map((r) => ({ name: r.emoji?.name ?? "?", count: r.count ?? 0 }));

  return { total: breakdown.reduce((sum, r) => sum + r.count, 0), breakdown };
}

/**
 * The feature-requests follow-up table from the #1114 spec. `issue` is the
 * `gh issue list --json` shape: state, stateReason, assignees, milestone.
 * Returns `null` when no status tag fits — an issue closed as a duplicate is
 * not done, so its post must be pointed at the canonical issue by hand rather
 * than tagged.
 */
export function featureRequestTag(issue, releasedVersion = null) {
  if (issue.state === "CLOSED") {
    if (issue.stateReason === "NOT_PLANNED") return WONT_DO;
    if (issue.stateReason === "DUPLICATE") return null;

    return releasedVersion ? "Released" : "Completed";
  }

  const inProgress = (issue.assignees?.length ?? 0) > 0 || Boolean(issue.milestone);

  return inProgress ? "In progress" : "Will Add";
}

/** #1114's name for the feature-requests mapping. */
export const expectedTag = featureRequestTag;

/**
 * The #bugs mapping (#1460): only a bug closed as completed whose fix is in a
 * stable tag is `Resolved`. Every other state is `null` — the forum has no
 * "tracked" or "in progress" tag, so an open bug's post carries none, and a
 * not-planned or duplicate bug gets a hand-written reply rather than a tag.
 * `releasedVersion` comes from `lowestStableVersion`, so a fix that is only in
 * a pre-release is `null` too.
 */
export function bugTag(issue, releasedVersion = null) {
  return issue.state === "CLOSED" && issue.stateReason === "COMPLETED" && releasedVersion ? RESOLVED : null;
}

export function rank(tag) {
  return tag ? (STATUS_RANK[tag] ?? 0) : 0;
}

/** Feature requests: forward moves only; Won't do is reachable from anywhere and terminal. */
export function featureRequestShouldPropose(current, expected) {
  if (expected === null || current === expected) return false;
  if (expected === WONT_DO) return true;
  if (current === WONT_DO) return false;

  return rank(expected) > rank(current);
}

/** #1114's name for the feature-requests ranking. */
export const shouldPropose = featureRequestShouldPropose;

/** Bugs: the one move there is, onto `Resolved` from a post not carrying it. */
export function bugShouldPropose(current, expected) {
  return expected === RESOLVED && current !== RESOLVED;
}

/**
 * Lowest stable `v<semver>` among tag names; pre-releases never count as
 * shipped. Stability is semver's rule, so `v3.2.0+build` is stable and
 * `v3.2.0-rc.1` is not.
 */
export function lowestStableVersion(tagNames) {
  const stable = tagNames
    .filter((name) => name.startsWith("v"))
    .map((name) => ({ name, version: name.slice(1) }))
    .filter(({ version }) => valid(version) && prerelease(version) === null)
    .sort((a, b) => compare(a.version, b.version));

  return stable[0]?.name ?? null;
}
