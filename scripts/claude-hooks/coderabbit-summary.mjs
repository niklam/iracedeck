/**
 * The merge gate's reading of CodeRabbit's summary comment (#1386).
 *
 * CodeRabbit keeps one issue comment per PR and edits it after every review
 * run. After a clean incremental review it is the only record that the new
 * head was reviewed: no review object is filed at that commit. This module
 * decides whether the comment says, consistently and in every place it says
 * it, that one commit was reviewed with nothing to act on. The gate accepts
 * the head when that commit is the head, and uses it as the start of the
 * #1307 replay when it is an older commit.
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
 * { login, __typename }, editor, isMinimized, createdAt, lastEditedAt, body }] }`.
 */

/** The first line of the summary comment, and nothing else, marks it. */
export const SUMMARY_OPENER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->";

/** One page of comments; a PR with more is refused rather than read partially. */
export const MAX_COMMENTS = 100;

const RECENT_START = "<!-- recent_review_start -->";
const RECENT_END = "<!-- recent_review_end -->";
const SHA = /^[0-9a-f]{40}$/;
const RANGE_LINE =
  /^Reviewing files that changed from the base of the PR and between ([0-9a-f]{40}) and ([0-9a-f]{40})\.$/;
const NO_ACTIONABLE = /^No actionable comments were generated in the recent review\./;
const ASSESSMENT = /<!-- change_assessment_commit:"([0-9a-f]{40})" -->/g;
const COVERAGE = /<!-- final_review_risk_coverage:(\{[^\n]*?\}) -->/g;

const lines = (text) => text.split("\n").map((l) => l.replace(/\r$/, ""));
const count = (text, needle) => text.split(needle).length - 1;
const isCodeRabbit = (actor) => actor?.login === "coderabbitai" && actor?.__typename === "Bot";
const refuse = (reason) => ({ ok: false, reason });

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
 * `final_review_risk_coverage` (`kind: "reviewed"`) both name `commit`:
 * `null` when they do, else the reason they do not.
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
  return null;
}

/**
 * The summary comment's verdict for `head`:
 *
 * - `{ ok: true, reviewed, atHead, editedAt }` when spec rules 1–4 hold for
 *   one commit `reviewed` — the recent review's range end, which both hidden
 *   markers name too. `atHead` says whether that is `head`; `editedAt` is
 *   when the comment's body was last written (`lastEditedAt`, else
 *   `createdAt`), for the caller to compare with the newest review object.
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
  const summaries = nodes.filter((c) => typeof c?.body === "string" && lines(c.body)[0] === SUMMARY_OPENER);
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
  // Any second "auto-generated comment" at all — an opener, a closer, or one
  // in a wording not seen yet — is a block this rule does not read.
  if (count(body.toLowerCase(), "auto-generated comment") !== 1) {
    const kinds = [...body.matchAll(/auto-generated comment:\s*(.*?)\s*by coderabbit\.ai/gi)].slice(1).map((m) => m[1]);
    return refuse(
      kinds.some((k) => /rate limit/i.test(k))
        ? "it carries a `rate limited` block: CodeRabbit hit its rate limit and did not review the newest commit — wait for the limit to reset, then ask `@coderabbitai review`"
        : `it carries another auto-generated CodeRabbit block${kinds.length ? ` (${[...new Set(kinds)].map((k) => `\`${k}\``).join(", ")})` : ""}, a state the gate does not read as reviewed`,
    );
  }
  const recent = parseRecentReview(body);
  if (!recent.ok) return recent;
  const disagreement = markerDisagreement(body, recent.to);
  if (disagreement) return refuse(disagreement);
  const editedAt = summary.lastEditedAt ?? summary.createdAt;
  return {
    ok: true,
    reviewed: recent.to,
    atHead: SHA.test(head ?? "") && recent.to === head,
    editedAt: typeof editedAt === "string" ? editedAt : undefined,
  };
}
