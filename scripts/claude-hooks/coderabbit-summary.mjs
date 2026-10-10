/**
 * The merge gate's reading of CodeRabbit's summary comment (#1386).
 *
 * CodeRabbit keeps one issue comment per PR and edits it after every review
 * run. After a clean incremental review it is the only record that the new
 * head was reviewed: no review object is filed at that commit. This module
 * decides whether the comment says, consistently and in every place it says
 * it, that one commit was reviewed with nothing to act on. The gate accepts
 * the head when that commit is the head, and uses it as the start of the
 * #1307 replay when it is an older commit — in both cases only once the
 * review's range start is traced back to a reviewed commit ({@link rangeChain}).
 *
 * Each statement is read only from its own block. PR #1383 is why: its
 * `rate limited` block carried a "Reviewing files … between <a> and <head>"
 * line for a review that never ran, while the recent-review block and both
 * hidden markers stayed at the commit that WAS reviewed. Every check is
 * written so that a reworded line, a renamed marker or a block not seen
 * before fails a condition — a change on CodeRabbit's side can only cost an
 * acceptance, never create one. Spec:
 * `docs/superpowers/specs/2026-10-10-issue-1386-changelog-fragments-merge-gate.md`, part B.
 *
 * Pure. Input is the PR's `comments` connection as `prComments` in `lib.mjs`
 * reads it: `{ totalCount, pageInfo: { hasNextPage }, nodes: [{ author:
 * { login, __typename }, editor, isMinimized, createdAt, lastEditedAt, body,
 * userContentEdits? }] }`, where the summary comment's node carries its edit
 * history: `{ totalCount, nodes: [{ editedAt, editor, deletedAt, diff }] }`,
 * newest first. Each node's `diff` is the whole body as that edit left it,
 * not a diff (measured on #1195, #1290, #1322 and #1381–#1383 on 2026-10-10:
 * in every one the newest node's `diff` is the current body).
 */

/** The first line of the summary comment, and nothing else, marks it. */
export const SUMMARY_OPENER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->";

/** One page of comments; a PR with more is refused rather than read partially. */
export const MAX_COMMENTS = 100;

/** One page of the summary's edit history; a longer one is refused, since an unread edit could be anyone's. */
export const MAX_EDITS = 100;

/**
 * How many earlier versions of the summary one verification may step back
 * through to reach the reviewed commit ({@link rangeChain}). #1290 needs one.
 */
export const MAX_CHAIN = 10;

/** A full, lower-case commit sha: the only form GitHub reports, and the only one the merge gate accepts. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

const RECENT_START = "<!-- recent_review_start -->";
const RECENT_END = "<!-- recent_review_end -->";
const RANGE_LINE =
  /^Reviewing files that changed from the base of the PR and between ([0-9a-f]{40}) and ([0-9a-f]{40})\.$/;
const NO_ACTIONABLE = /^No actionable comments were generated in the recent review\./;
const ASSESSMENT = /<!-- change_assessment_commit:"([0-9a-f]{40})" -->/g;
const COVERAGE = /<!-- final_review_risk_coverage:(\{[^\n]*?\}) -->/g;

const lines = (text) => text.split("\n").map((l) => l.replace(/\r$/, ""));
const count = (text, needle) => text.split(needle).length - 1;
const isCodeRabbit = (actor) => actor?.login === "coderabbitai" && actor?.__typename === "Bot";
const refuse = (reason) => ({ ok: false, reason });

/** Whether a comment node is a summary comment: its body's first line is {@link SUMMARY_OPENER}. */
export const isSummaryComment = (c) => typeof c?.body === "string" && lines(c.body)[0] === SUMMARY_OPENER;

/**
 * The recent-review block's statement: `{ ok, from, to }` for the one range
 * line `Reviewing files … between <from> and <to>.`, both full shas, in a
 * block that says no actionable comments were generated — or `{ ok: false,
 * reason }`. Reads only between the one `recent_review_start` and the one
 * `recent_review_end` marker; a range line anywhere else is not this block's.
 */
export function parseRecentReview(body) {
  const starts = count(body, "recent_review_start");
  const ends = count(body, "recent_review_end");
  if (starts !== 1 || ends !== 1 || count(body, RECENT_START) !== 1 || count(body, RECENT_END) !== 1)
    return refuse(
      `it does not carry exactly one recent-review block (${starts} start and ${ends} end markers) — CodeRabbit has not finished a review it summarised`,
    );
  const a = body.indexOf(RECENT_START) + RECENT_START.length;
  const b = body.indexOf(RECENT_END);
  if (b < a) return refuse("its recent-review block ends before it starts");
  const block = lines(body.slice(a, b));
  const ranges = block.filter((l) => /Reviewing files/i.test(l));
  if (ranges.length !== 1)
    return refuse(`its recent-review block names ${ranges.length} review ranges, not exactly one`);
  const range = RANGE_LINE.exec(ranges[0]);
  if (!range)
    return refuse(
      "its recent-review block's range line is not an unquoted `Reviewing files … between <sha> and <sha>.` with two full shas",
    );
  if (block.some((l) => /Actionable comments posted/i.test(l)))
    return refuse("its recent review posted actionable comments");
  const clean = block.filter((l) => /No actionable comments/i.test(l));
  if (clean.length !== 1 || !NO_ACTIONABLE.test(clean[0]))
    return refuse('its recent-review block does not say "No actionable comments were generated in the recent review."');
  return { ok: true, from: range[1], to: range[2] };
}

/**
 * Whether the one hidden `change_assessment_commit` and the one hidden
 * `final_review_risk_coverage` (`kind: "reviewed"`, `sourceCommitId` equal
 * to `coveredCommitId`) both name `commit`: `null` when they do, else the
 * reason they do not.
 */
export function markerDisagreement(body, commit) {
  if (count(body, "change_assessment_commit") !== 1)
    return `it carries ${count(body, "change_assessment_commit")} change_assessment_commit markers, not exactly one`;
  const assessed = [...body.matchAll(ASSESSMENT)];
  if (assessed.length !== 1) return "its change_assessment_commit marker does not name one full sha";
  if (assessed[0][1] !== commit)
    return `its change_assessment_commit marker names ${assessed[0][1].slice(0, 9)}, not the recent review's ${commit.slice(0, 9)}`;
  if (count(body, "final_review_risk_coverage") !== 1)
    return `it carries ${count(body, "final_review_risk_coverage")} final_review_risk_coverage markers, not exactly one`;
  const covered = [...body.matchAll(COVERAGE)];
  if (covered.length !== 1) return "its final_review_risk_coverage marker is not one JSON object on one line";
  let coverage;
  try {
    coverage = JSON.parse(covered[0][1]);
  } catch {
    return "its final_review_risk_coverage marker is not valid JSON";
  }
  if (coverage?.kind !== "reviewed")
    return `its final_review_risk_coverage marker's kind is ${JSON.stringify(coverage?.kind)}, not "reviewed"`;
  if (coverage.coveredCommitId !== commit)
    return `its final_review_risk_coverage marker covers ${String(coverage.coveredCommitId).slice(0, 9)}, not the recent review's ${commit.slice(0, 9)}`;
  // Every clean review read so far carries the same sha in both fields. One
  // that differs is a shape not seen yet (a coverage carried over from an
  // earlier commit, say), so it does not count.
  if (coverage.sourceCommitId !== coverage.coveredCommitId)
    return `its final_review_risk_coverage marker's sourceCommitId ${String(coverage.sourceCommitId).slice(0, 9)} is not its coveredCommitId ${commit.slice(0, 9)}`;
  return null;
}

/**
 * What one version of the summary body says under rules 2–4: `{ from, to }`
 * for a clean recent review of `to` whose range starts at `from`, or
 * `{ reason }` when the version does not say that.
 */
function statement(body) {
  // Any second "auto-generated comment" at all — an opener, a closer, or one
  // in a wording not seen yet — is a block this rule does not read.
  if (count(body.toLowerCase(), "auto-generated comment") !== 1) {
    const kinds = [...body.matchAll(/auto-generated comment:\s*(.*?)\s*by coderabbit\.ai/gi)].slice(1).map((m) => m[1]);
    return {
      reason: kinds.some((k) => /rate limit/i.test(k))
        ? "it carries a `rate limited` block: CodeRabbit hit its rate limit and did not review the newest commit — wait for the limit to reset, then ask `@coderabbitai review`"
        : `it carries another auto-generated CodeRabbit block${kinds.length ? ` (${[...new Set(kinds)].map((k) => `\`${k}\``).join(", ")})` : ""}, a state the gate does not read as reviewed`,
    };
  }
  const recent = parseRecentReview(body);
  if (!recent.ok) return { reason: recent.reason };
  const disagreement = markerDisagreement(body, recent.to);
  if (disagreement) return { reason: disagreement };
  return { from: recent.from, to: recent.to };
}

/**
 * Why the summary's edit history does not prove that only CodeRabbit ever
 * wrote it, or `null` when it does. GraphQL documents `IssueComment.editor`
 * only as "the actor who edited the comment", so the last editor alone could
 * hide an earlier edit by someone else: every recorded edit must be the bot's,
 * the history must be complete, undeleted and strictly newest first, and its
 * newest version must be the body read — which also ties `prComments`' two
 * reads together.
 */
function historyProblem(history, body) {
  if (!history || typeof history.totalCount !== "number" || !Array.isArray(history.nodes))
    return "its edit history could not be read, so it cannot be proven CodeRabbit's alone";
  if (history.totalCount > MAX_EDITS || history.nodes.length !== history.totalCount)
    return `it has ${history.totalCount} recorded edits and ${history.nodes.length} were read (at most ${MAX_EDITS}), so its history cannot be proven CodeRabbit's alone`;
  for (const edit of history.nodes) {
    if (!isCodeRabbit(edit?.editor))
      return `its edit history has an edit by ${edit?.editor?.__typename ?? "an unknown"} ${edit?.editor?.login ?? "actor"}, not by the Bot coderabbitai`;
    if (edit.deletedAt != null) return "its edit history has a deleted revision";
    if (typeof edit.diff !== "string" || typeof edit.editedAt !== "string")
      return "its edit history has a revision whose body or time could not be read";
  }
  const times = history.nodes.map((e) => Date.parse(e.editedAt));
  if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t >= times[i - 1])))
    return "its edit history is not strictly newest first, so its versions cannot be ordered";
  if (history.nodes.length && history.nodes[0].diff !== body)
    return "its newest recorded version is not the body read, so the comment changed while it was read";
  return null;
}

/**
 * The summary comment's verdict for `head`:
 *
 * - `{ ok: true, reviewed, from, atHead, editedAt, earlier }` when spec rules
 *   1–4 hold for one commit `reviewed` — the recent review's range end,
 *   which both hidden markers name too — and every recorded edit of the
 *   comment is CodeRabbit's. `from` is the range's start, which the caller
 *   must still trace back to a reviewed commit ({@link rangeChain}) before
 *   `reviewed` counts. `atHead` says whether `reviewed` is `head`; `editedAt`
 *   is when the comment's body was last written (`lastEditedAt`, else
 *   `createdAt`), for the caller to compare with the newest review object.
 *   `earlier` lists, newest first, the `{ from, to }` of every earlier
 *   version of the body that passes the same rules itself.
 * - `{ ok: false, reason }` otherwise, the reason naming the first failed
 *   condition, worded as the rest of a sentence that starts "the summary
 *   comment does not count because …".
 */
export function readSummary(comments, head) {
  const nodes = comments?.nodes;
  if (!Array.isArray(nodes) || typeof comments.totalCount !== "number")
    return refuse("gh could not read the PR's comments");
  if (
    comments.totalCount > MAX_COMMENTS ||
    comments.pageInfo?.hasNextPage !== false ||
    nodes.length !== comments.totalCount
  )
    return refuse(
      `the PR has ${comments.totalCount} comments and only the first ${MAX_COMMENTS} are read, so the summary cannot be proven the only one`,
    );
  const summaries = nodes.filter(isSummaryComment);
  if (summaries.length !== 1)
    return refuse(
      summaries.length
        ? `the PR has ${summaries.length} summary comments, not exactly one`
        : "the PR has no CodeRabbit summary comment",
    );
  const [summary] = summaries;
  if (!isCodeRabbit(summary.author))
    return refuse(
      `the summary comment's author is ${summary.author?.__typename ?? "unknown"} ${summary.author?.login ?? "(none)"}, not the Bot coderabbitai`,
    );
  if (summary.editor != null && !isCodeRabbit(summary.editor))
    return refuse(
      `the summary comment was last edited by ${summary.editor?.login ?? "an unknown actor"}, not by CodeRabbit`,
    );
  if (summary.isMinimized !== false) return refuse("the summary comment is minimized");
  const { body } = summary;
  const history = summary.userContentEdits;
  const tampered = historyProblem(history, body);
  if (tampered) return refuse(tampered);
  const now = statement(body);
  if (now.reason) return refuse(now.reason);
  // Each earlier version, judged by the same rules as the current body. The
  // newest node IS the current body (checked above), so it is skipped.
  const earlier = history.nodes
    .slice(1)
    .map((e) => (isSummaryComment({ body: e.diff }) ? statement(e.diff) : { reason: "not a summary" }))
    .filter((v) => !v.reason);
  const editedAt = summary.lastEditedAt ?? summary.createdAt;
  return {
    ok: true,
    reviewed: now.to,
    from: now.from,
    atHead: FULL_SHA.test(head ?? "") && now.to === head,
    editedAt: typeof editedAt === "string" ? editedAt : undefined,
    earlier,
  };
}

/**
 * Walks an accepted summary's range start back to `anchor`, the commit of the
 * newest CodeRabbit review object. A recent review of `from..to` says only
 * that the commits after `from` were reviewed, so `to` counts as reviewed only
 * once `from` is shown to have been. A start is shown when it IS `anchor`, or
 * when an earlier version of the same comment — strictly older than the
 * version the step started from — carries a clean recent review ending at
 * it, whose own start is then walked the same way, at most {@link MAX_CHAIN}
 * steps back.
 *
 * Returns `{ reached, starts }`: `reached` when the walk arrived at `anchor`;
 * `starts` every range start it visited, newest first, so the caller can try
 * the remaining way on each — a start that is a clean pure rebase of `anchor`
 * by the #1307 replay. Pure; the replay is the caller's.
 */
export function rangeChain(summary, anchor) {
  const starts = [summary.from];
  let at = -1;
  for (let step = 0; step < MAX_CHAIN && starts.at(-1) !== anchor; step++) {
    const k = summary.earlier.findIndex((v, i) => i > at && v.to === starts.at(-1));
    if (k < 0) break;
    at = k;
    starts.push(summary.earlier[k].from);
  }
  return { reached: FULL_SHA.test(anchor ?? "") && starts.at(-1) === anchor, starts };
}
