import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  markerDisagreement,
  MAX_COMMENTS,
  parseRecentReview,
  readSummary,
  SUMMARY_OPENER,
} from "./coderabbit-summary.mjs";

/**
 * Real summary comment bodies, verbatim except the change-stack link's
 * token-shaped `scope` value, with the PR's final head and the comment's
 * real timestamps as `gh api graphql` reported them on 2026-10-10.
 */
const REAL = {
  1290: {
    head: "0fba52955ee91824f9586cfaf0e42fa04d06e3d4",
    created: "2026-09-30T18:37:12Z",
    edited: "2026-09-30T19:27:50Z",
  },
  1322: {
    head: "3ae30d2844f4c4bd749de5e30521491add4b04fd",
    created: "2026-10-04T11:22:30Z",
    edited: "2026-10-04T11:37:08Z",
  },
  1381: {
    head: "59f89b8b2ead1541654e5df345df3892996fdfe2",
    created: "2026-10-10T10:33:56Z",
    edited: "2026-10-10T10:38:22Z",
  },
  1382: {
    head: "f84e952c9462f314713f9e4dcedbb18362c8fbc8",
    created: "2026-10-10T10:44:02Z",
    edited: "2026-10-10T10:45:51Z",
  },
  1383: {
    head: "0b0e4d758227192d3c87c2c72bf48d7a0eadd9a2",
    created: "2026-10-10T10:47:03Z",
    edited: "2026-10-10T10:55:21Z",
  },
  1195: {
    head: "9387f2f90c648798753f1f9f754306ea92f52802",
    created: "2026-09-21T17:37:21Z",
    edited: "2026-09-21T18:20:01Z",
  },
};
const REVIEWED_1383 = "ab5e21c6f1e66291dcb96694fadc4ecb48236b3d";
const OTHER = "5555555555555555555555555555555555555555";

const body = (n) => readFileSync(new URL(`./__fixtures__/coderabbit-summary/pr-${n}.md`, import.meta.url), "utf8");
const BOT = { login: "coderabbitai", __typename: "Bot" };
const MAINTAINER = { login: "niklam", __typename: "User" };

/** A summary comment node as `prComments` returns it. */
const summaryNode = (text, extra = {}) => ({
  author: BOT,
  editor: BOT,
  isMinimized: false,
  createdAt: "2026-10-10T10:00:00Z",
  lastEditedAt: "2026-10-10T11:00:00Z",
  body: text,
  ...extra,
});

/** The `comments` connection around `nodes`, complete unless overridden — with a maintainer comment and a bot reply beside the summary, as real PRs have. */
const connection = (nodes, extra = {}) => {
  const all = [
    ...nodes,
    {
      author: MAINTAINER,
      editor: null,
      isMinimized: false,
      createdAt: "2026-10-10T12:00:00Z",
      lastEditedAt: null,
      body: "@coderabbitai review",
    },
    {
      author: BOT,
      editor: null,
      isMinimized: false,
      createdAt: "2026-10-10T12:00:05Z",
      lastEditedAt: null,
      body: "<!-- This is an auto-generated reply by CodeRabbit -->\nOn it.",
    },
  ];
  return { totalCount: all.length, pageInfo: { hasNextPage: false }, nodes: all, ...extra };
};

const real = (n) => connection([summaryNode(body(n), { createdAt: REAL[n].created, lastEditedAt: REAL[n].edited })]);

/** `text` with `from` replaced by `to`, asserting it matched exactly `times` times — a doctoring that matches nothing tests nothing. */
function doctor(text, from, to, times = 1) {
  const hits = text.split(from).length - 1;
  expect(hits, `doctoring anchor ${JSON.stringify(from)}`).toBe(times);
  return text.split(from).join(to);
}

const HEAD = REAL[1290].head;
const BASE_1290 = body(1290);
const RANGE_1290 = `Reviewing files that changed from the base of the PR and between 4d33e1f32178e69684739f5d31e037b72bff4987 and ${HEAD}.`;
const ASSESS_1290 = `<!-- change_assessment_commit:"${HEAD}" -->`;
const COVER_1290 = `<!-- final_review_risk_coverage:{"sourceCommitId":"${HEAD}","coveredCommitId":"${HEAD}","kind":"reviewed"} -->`;
const NO_ACTIONABLE = "No actionable comments were generated in the recent review. 🎉";

const verdict = (text, extra) => readSummary(connection([summaryNode(text, extra)]), HEAD);
const refusedFor = (text, reason, extra) => {
  const v = verdict(text, extra);
  expect(v.ok, `expected a refusal matching ${reason}`).toBe(false);
  expect(v.reason).toMatch(reason);
  return v;
};

describe("readSummary over real CodeRabbit summary comments", () => {
  for (const n of [1290, 1322, 1381, 1382])
    it(`accepts PR #${n}'s summary at its final head`, () =>
      expect(readSummary(real(n), REAL[n].head)).toEqual({
        ok: true,
        reviewed: REAL[n].head,
        atHead: true,
        editedAt: REAL[n].edited,
      }));

  it("refuses PR #1383 at 0b0e4d758 — its follow-up was never reviewed, CodeRabbit was rate limited", () => {
    const v = readSummary(real(1383), REAL[1383].head);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/`rate limited` block/);
    expect(v.reason).toMatch(/wait for the limit to reset/);
  });

  it("reads PR #1383's recent review as ending at ab5e21c6f, the commit that was reviewed, and its markers agree", () => {
    expect(parseRecentReview(body(1383))).toEqual({
      ok: true,
      from: "19dc18c8e62b6587ec9f13ba0af1c91b1e77d1c2",
      to: REVIEWED_1383,
    });
    expect(markerDisagreement(body(1383), REVIEWED_1383)).toBeNull();
    expect(markerDisagreement(body(1383), REAL[1383].head)).toMatch(/change_assessment_commit marker names ab5e21c6f/);
  });

  // Defence in depth on #1383: each layer alone keeps its unreviewed head out.
  const RATE_LIMIT_MARKER = "auto-generated comment: rate limited by coderabbit.ai";
  const renamedPastRule2 = () => doctor(body(1383), RATE_LIMIT_MARKER, "generated notice: rate limited", 2);

  it("reads #1383's rate-limited range as no review even when that block's marker is reworded past rule 2", () =>
    expect(readSummary(connection([summaryNode(renamedPastRule2())]), REAL[1383].head)).toMatchObject({
      ok: true,
      reviewed: REVIEWED_1383,
      atHead: false,
    }));

  it("refuses #1383 through its markers alone when its recent review also names the unreviewed head", () => {
    const advanced = doctor(
      renamedPastRule2(),
      `between 19dc18c8e62b6587ec9f13ba0af1c91b1e77d1c2 and ${REVIEWED_1383}.`,
      `between 19dc18c8e62b6587ec9f13ba0af1c91b1e77d1c2 and ${REAL[1383].head}.`,
    );
    const v = readSummary(connection([summaryNode(advanced)]), REAL[1383].head);
    expect(v).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /change_assessment_commit marker names ab5e21c6f, not the recent review's 0b0e4d758/,
      ),
    });
  });

  it("refuses PR #1195 — it predates the final_review_risk_coverage marker, and the gate fails closed", () => {
    const v = readSummary(real(1195), REAL[1195].head);
    expect(v).toEqual({ ok: false, reason: expect.stringMatching(/0 final_review_risk_coverage markers/) });
    // Everything else in it agrees with the head: the missing marker is the only reason.
    expect(parseRecentReview(body(1195))).toMatchObject({ ok: true, to: REAL[1195].head });
  });

  it("stores the fixtures with the change-stack token redacted", () => {
    for (const n of Object.keys(REAL)) {
      expect(body(n)).not.toMatch(/scope=(?!REDACTED)/);
      expect(body(n).startsWith(`${SUMMARY_OPENER}\n`)).toBe(true);
    }
  });
});

describe("readSummary: one doctored variant per condition", () => {
  it("accepts the undoctored base, so every refusal below is the doctoring's", () =>
    expect(verdict(BASE_1290)).toMatchObject({ ok: true, atHead: true, reviewed: HEAD }));

  describe("rule 1: exactly one summary, by the bot, edited only by the bot, not minimized, all comments read", () => {
    it("refuses a summary authored by a User", () =>
      refusedFor(BASE_1290, /author is User niklam/, { author: MAINTAINER }));
    it("refuses a User that merely carries the bot's login", () =>
      refusedFor(BASE_1290, /author is User coderabbitai/, { author: { login: "coderabbitai", __typename: "User" } }));
    it("refuses the [bot]-suffixed REST spelling — the GraphQL read gives the bare login", () =>
      refusedFor(BASE_1290, /not the Bot coderabbitai/, { author: { login: "coderabbitai[bot]", __typename: "Bot" } }));
    it("refuses a look-alike bot", () =>
      refusedFor(BASE_1290, /not the Bot coderabbitai/, { author: { login: "coderabbitai-fan", __typename: "Bot" } }));
    it("refuses a summary last edited by anyone but the bot", () =>
      refusedFor(BASE_1290, /last edited by niklam/, { editor: MAINTAINER }));
    it("refuses an editor that is a User carrying the bot's login", () =>
      refusedFor(BASE_1290, /last edited by coderabbitai, not by CodeRabbit/, {
        editor: { login: "coderabbitai", __typename: "User" },
      }));
    it("accepts a summary never edited at all, taking its creation time", () =>
      expect(verdict(BASE_1290, { editor: null, lastEditedAt: null })).toMatchObject({
        ok: true,
        editedAt: "2026-10-10T10:00:00Z",
      }));
    it("refuses a minimized summary, and one whose minimized flag is missing", () => {
      refusedFor(BASE_1290, /minimized/, { isMinimized: true });
      refusedFor(BASE_1290, /minimized/, { isMinimized: undefined });
    });
    it("refuses two summaries — whoever wrote the second", () => {
      for (const second of [summaryNode(BASE_1290), summaryNode(BASE_1290, { author: MAINTAINER, editor: null })]) {
        const v = readSummary(connection([summaryNode(BASE_1290), second]), HEAD);
        expect(v).toEqual({ ok: false, reason: "the PR has 2 summary comments, not exactly one" });
      }
    });
    it("refuses a PR with no summary, including one whose marker is not the first line", () => {
      expect(readSummary(connection([]), HEAD).reason).toMatch(/no CodeRabbit summary comment/);
      expect(readSummary(connection([summaryNode(`\n${BASE_1290}`)]), HEAD).reason).toMatch(/no CodeRabbit summary/);
      expect(readSummary(connection([summaryNode(`> ${BASE_1290}`)]), HEAD).reason).toMatch(/no CodeRabbit summary/);
    });
    it("refuses more than one page of comments, and a read that is not complete", () => {
      const ok = connection([summaryNode(BASE_1290)]);
      expect(readSummary({ ...ok, totalCount: MAX_COMMENTS + 1 }, HEAD).reason).toMatch(/only the first 100 are read/);
      expect(readSummary({ ...ok, pageInfo: { hasNextPage: true } }, HEAD).ok).toBe(false);
      expect(readSummary({ ...ok, pageInfo: undefined }, HEAD).ok).toBe(false);
      expect(readSummary({ ...ok, nodes: ok.nodes.slice(1) }, HEAD).ok).toBe(false);
    });
    it("refuses when gh could not read the comments at all", () => {
      for (const c of [undefined, null, {}, { nodes: [] }, { totalCount: 0 }])
        expect(readSummary(c, HEAD).reason).toMatch(/gh could not read the PR's comments/);
    });
  });

  describe("rule 2: no other auto-generated block", () => {
    it("refuses a rate-limited block, naming it", () =>
      refusedFor(
        doctor(
          BASE_1290,
          "<!-- recent_review_start -->",
          "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> limit\n<!-- end of auto-generated comment: rate limited by coderabbit.ai -->\n\n<!-- recent_review_start -->",
        ),
        /`rate limited` block/,
      ));
    it("refuses a block it has never seen, naming its kind", () =>
      refusedFor(
        doctor(
          BASE_1290,
          "<!-- recent_review_start -->",
          "<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->\n<!-- recent_review_start -->",
        ),
        /another auto-generated CodeRabbit block \(`review in progress`\)/,
      ));
    it("refuses any second auto-generated marker, even a closer or one in an unknown wording", () => {
      refusedFor(
        `${BASE_1290}\n<!-- end of auto-generated comment: summarize by coderabbit.ai -->`,
        /another auto-generated CodeRabbit block/,
      );
      refusedFor(
        `${BASE_1290}\n<!-- Auto-Generated Comment from somewhere -->`,
        /another auto-generated CodeRabbit block/,
      );
    });
  });

  describe("rule 3: one recent-review block, one unquoted full-sha range ending at the head, no actionable comments", () => {
    it("refuses a missing, duplicated or reversed block", () => {
      refusedFor(doctor(BASE_1290, "<!-- recent_review_start -->", ""), /0 start and 1 end markers/);
      refusedFor(doctor(BASE_1290, "<!-- recent_review_end -->", ""), /1 start and 0 end markers/);
      refusedFor(`${BASE_1290}\n<!-- recent_review_start -->\n<!-- recent_review_end -->`, /2 start and 2 end/);
      refusedFor(
        doctor(
          doctor(BASE_1290, "<!-- recent_review_start -->", "@@START@@"),
          "<!-- recent_review_end -->",
          "<!-- recent_review_start -->",
        ).replace("@@START@@", "<!-- recent_review_end -->"),
        /ends before it starts/,
      );
      refusedFor(
        doctor(BASE_1290, "<!-- recent_review_start -->", "<!--recent_review_start-->"),
        /exactly one recent-review block/,
      );
    });
    it("refuses a quoted range line — the shape of #1383's rate-limited plan", () =>
      refusedFor(doctor(BASE_1290, RANGE_1290, `> ${RANGE_1290}`), /not an unquoted/));
    it("refuses an indented range line", () =>
      refusedFor(doctor(BASE_1290, RANGE_1290, `    ${RANGE_1290}`), /not an unquoted/));
    it("refuses short shas in the range line", () =>
      refusedFor(
        doctor(
          BASE_1290,
          RANGE_1290,
          "Reviewing files that changed from the base of the PR and between 4d33e1f32 and 0fba52955.",
        ),
        /two full shas/,
      ));
    it("refuses upper-case shas, which GitHub never prints", () =>
      refusedFor(doctor(BASE_1290, RANGE_1290, RANGE_1290.replace(HEAD, HEAD.toUpperCase())), /two full shas/));
    it("refuses two range lines in the block", () =>
      refusedFor(doctor(BASE_1290, RANGE_1290, `${RANGE_1290}\n\n${RANGE_1290}`), /names 2 review ranges/));
    it("refuses a block with no range line, though one sits outside it", () =>
      refusedFor(`${doctor(BASE_1290, RANGE_1290, "")}\n${RANGE_1290}`, /names 0 review ranges/));
    it("refuses a block whose range ends at another commit while the markers name the head", () =>
      refusedFor(
        doctor(BASE_1290, RANGE_1290, RANGE_1290.replace(HEAD, OTHER)),
        /change_assessment_commit marker names 0fba52955, not the recent review's 555555555/,
      ));
    it("reports a consistent summary of another commit as reviewed, but not at the head", () => {
      const moved = doctor(
        doctor(
          doctor(BASE_1290, RANGE_1290, RANGE_1290.replace(HEAD, OTHER)),
          ASSESS_1290,
          ASSESS_1290.replace(HEAD, OTHER),
        ),
        COVER_1290,
        COVER_1290.replaceAll(HEAD, OTHER),
      );
      expect(verdict(moved)).toMatchObject({ ok: true, reviewed: OTHER, atHead: false });
    });
    it("refuses a recent review that posted actionable comments", () =>
      refusedFor(doctor(BASE_1290, NO_ACTIONABLE, "**Actionable comments posted: 1**"), /posted actionable comments/));
    it("refuses actionable comments even beside a no-actionable line", () =>
      refusedFor(
        doctor(BASE_1290, NO_ACTIONABLE, `${NO_ACTIONABLE}\n\nActionable comments posted: 2`),
        /posted actionable comments/,
      ));
    it("refuses a block without the no-actionable line, or with it quoted", () => {
      refusedFor(doctor(BASE_1290, NO_ACTIONABLE, ""), /does not say "No actionable comments/);
      refusedFor(doctor(BASE_1290, NO_ACTIONABLE, `> ${NO_ACTIONABLE}`), /does not say "No actionable comments/);
    });
  });

  describe("rule 4: the hidden markers agree with the recent review", () => {
    it("refuses a missing, duplicated or disagreeing change_assessment_commit", () => {
      refusedFor(doctor(BASE_1290, ASSESS_1290, ""), /0 change_assessment_commit markers/);
      refusedFor(
        doctor(BASE_1290, ASSESS_1290, `${ASSESS_1290}\n${ASSESS_1290}`),
        /2 change_assessment_commit markers/,
      );
      refusedFor(
        doctor(BASE_1290, ASSESS_1290, ASSESS_1290.replace(HEAD, OTHER)),
        /names 555555555, not the recent review's 0fba52955/,
      );
      refusedFor(
        doctor(BASE_1290, ASSESS_1290, ASSESS_1290.replace(HEAD, HEAD.slice(0, 9))),
        /does not name one full sha/,
      );
    });
    it("refuses a missing, duplicated or disagreeing final_review_risk_coverage", () => {
      refusedFor(doctor(BASE_1290, COVER_1290, ""), /0 final_review_risk_coverage markers/);
      refusedFor(doctor(BASE_1290, COVER_1290, `${COVER_1290}\n${COVER_1290}`), /2 final_review_risk_coverage markers/);
      refusedFor(
        doctor(
          BASE_1290,
          COVER_1290,
          COVER_1290.replace(`"coveredCommitId":"${HEAD}"`, `"coveredCommitId":"${OTHER}"`),
        ),
        /covers 555555555, not the recent review's 0fba52955/,
      );
    });
    it("refuses a coverage marker whose kind is not reviewed", () =>
      refusedFor(
        doctor(BASE_1290, COVER_1290, COVER_1290.replace('"kind":"reviewed"', '"kind":"skipped"')),
        /kind is "skipped"/,
      ));
    it("refuses a coverage marker that is not JSON, or not one line", () => {
      refusedFor(
        doctor(BASE_1290, COVER_1290, COVER_1290.replace('"kind":"reviewed"}', '"kind":"reviewed",}')),
        /not valid JSON/,
      );
      refusedFor(doctor(BASE_1290, COVER_1290, COVER_1290.replace(",", ",\n")), /not one JSON object on one line/);
    });
  });

  it("does not call a summary at the head when the head given is not a full sha", () =>
    expect(readSummary(connection([summaryNode(BASE_1290)]), HEAD.slice(0, 9))).toMatchObject({
      ok: true,
      atHead: false,
    }));
});
