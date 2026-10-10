import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FULL_SHA,
  markerDisagreement,
  MAX_CHAIN,
  MAX_COMMENTS,
  MAX_EDITS,
  parseRecentReview,
  rangeChain,
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
/**
 * The summary comment's real edit history (`userContentEdits(last: 100)`,
 * newest first), as `gh api graphql` returned it on 2026-10-10 — verbatim
 * except the same `scope` redaction as the bodies. A fresh copy per call, so
 * a test may doctor it.
 */
const edits = (n) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/coderabbit-summary/pr-${n}.edits.json`, import.meta.url), "utf8"));
const BOT = { login: "coderabbitai", __typename: "Bot" };
const MAINTAINER = { login: "niklam", __typename: "User" };

/** A history of one version: `text`, written by the bot at `at`. */
const soleVersion = (text, at = "2026-10-10T11:00:00Z") => ({
  totalCount: 1,
  nodes: [{ editedAt: at, editor: BOT, deletedAt: null, diff: text }],
});

/** A summary comment node as `prComments` returns it, its history one bot-written version unless given. */
const summaryNode = (text, extra = {}) => {
  const node = {
    author: BOT,
    editor: BOT,
    isMinimized: false,
    createdAt: "2026-10-10T10:00:00Z",
    lastEditedAt: "2026-10-10T11:00:00Z",
    body: text,
    ...extra,
  };
  if (!("userContentEdits" in extra))
    node.userContentEdits = soleVersion(node.body, node.lastEditedAt ?? node.createdAt ?? "2026-10-10T11:00:00Z");
  return node;
};

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

const real = (n, history = edits(n)) =>
  connection([
    summaryNode(body(n), { createdAt: REAL[n].created, lastEditedAt: REAL[n].edited, userContentEdits: history }),
  ]);

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
    it(`accepts PR #${n}'s summary at its final head, with its real edit history`, () =>
      expect(readSummary(real(n), REAL[n].head)).toMatchObject({
        ok: true,
        reviewed: REAL[n].head,
        from: expect.stringMatching(FULL_SHA),
        atHead: true,
        editedAt: REAL[n].edited,
      }));

  it("stores each real history newest first, ending at the stored body, every edit the bot's", () => {
    for (const n of Object.keys(REAL)) {
      const h = edits(n);
      expect(h.nodes).toHaveLength(h.totalCount);
      expect(h.nodes[0].diff).toBe(body(n));
      for (const e of h.nodes) expect(e.editor).toEqual(BOT);
    }
  });

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
      for (const e of edits(n).nodes) expect(e.diff).not.toMatch(/scope=(?!REDACTED)|gh[a-z]_[A-Za-z0-9]{8}/);
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
      expect(
        verdict(BASE_1290, { editor: null, lastEditedAt: null, userContentEdits: { totalCount: 0, nodes: [] } }),
      ).toMatchObject({
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

const APPROVED_1290 = "9fe7aa1a5a19a02cd160cef12c329ecf64e8e5bb";
const FOLLOW_UP_1290 = "4d33e1f32178e69684739f5d31e037b72bff4987";
const FIRST_1290 = "20e93d3272b8412f900a2ddbf8a7950dc975507b";
const REVIEWED_1322 = "4fd934c833edee796acadd4963616d7b7831e1f1";

/** #1290's real summary, its real history passed through `mutate` first. */
const withHistory = (mutate) => {
  const h = edits(1290);
  mutate(h);
  return readSummary(real(1290, h), HEAD);
};

describe("readSummary: every recorded edit is CodeRabbit's", () => {
  it("accepts #1290's real eight-version history", () => expect(withHistory(() => {})).toMatchObject({ ok: true }));

  it("refuses a foreign editor anywhere in the history, though the comment's last editor is the bot", () => {
    for (const k of [0, 3, 7])
      expect(withHistory((h) => (h.nodes[k].editor = MAINTAINER))).toEqual({
        ok: false,
        reason: expect.stringMatching(/edit history has an edit by User niklam, not by the Bot coderabbitai/),
      });
  });

  it("refuses a User carrying the bot's login, a missing editor and a null one", () => {
    for (const editor of [{ login: "coderabbitai", __typename: "User" }, undefined, null])
      expect(withHistory((h) => (h.nodes[2].editor = editor)).reason).toMatch(/edit history has an edit by/);
  });

  it("refuses a truncated history: more edits than one page, or fewer read than recorded", () => {
    expect(withHistory((h) => (h.totalCount = MAX_EDITS + 1)).reason).toMatch(
      /101 recorded edits and 8 were read \(at most 100\)/,
    );
    expect(withHistory((h) => (h.totalCount = 9)).reason).toMatch(/cannot be proven CodeRabbit's alone/);
    expect(withHistory((h) => h.nodes.pop()).reason).toMatch(/cannot be proven CodeRabbit's alone/);
  });

  it("refuses a history that could not be read", () => {
    for (const h of [undefined, null, { nodes: [] }, { totalCount: 1 }])
      expect(readSummary(connection([summaryNode(BASE_1290, { userContentEdits: h })]), HEAD).reason).toMatch(
        /edit history could not be read/,
      );
  });

  it("refuses a deleted revision, and one whose body or time is missing", () => {
    expect(withHistory((h) => (h.nodes[4].deletedAt = "2026-09-30T20:00:00Z")).reason).toMatch(/deleted revision/);
    expect(withHistory((h) => (h.nodes[4].diff = null)).reason).toMatch(/body or time could not be read/);
    expect(withHistory((h) => delete h.nodes[4].editedAt).reason).toMatch(/body or time could not be read/);
  });

  it("refuses a history that is not strictly newest first", () => {
    expect(withHistory((h) => h.nodes.splice(2, 2, h.nodes[3], h.nodes[2])).reason).toMatch(/not strictly newest/);
    expect(withHistory((h) => (h.nodes[3].editedAt = h.nodes[2].editedAt)).reason).toMatch(/not strictly newest/);
  });

  it("refuses a body that is not the history's newest version — the comment changed between the two reads", () =>
    expect(withHistory((h) => (h.nodes[0].diff = h.nodes[1].diff)).reason).toMatch(/changed while it was read/));
});

describe("markerDisagreement: the coverage's source is the commit it covers", () => {
  it("refuses a coverage carried over from another commit", () =>
    refusedFor(
      doctor(BASE_1290, COVER_1290, COVER_1290.replace(`"sourceCommitId":"${HEAD}"`, `"sourceCommitId":"${OTHER}"`)),
      /sourceCommitId 555555555 is not its coveredCommitId 0fba52955/,
    ));
  it("refuses a coverage with no sourceCommitId — a shape not seen yet", () =>
    refusedFor(
      doctor(BASE_1290, COVER_1290, COVER_1290.replace(`"sourceCommitId":"${HEAD}",`, "")),
      /sourceCommitId undefined is not its coveredCommitId/,
    ));
});

describe("rangeChain: the recent review's start traced back to the review object", () => {
  /** The 1290 body with its recent review moved to `from..to`, both markers following `to`. */
  const versionOf = (from, to) =>
    doctor(
      doctor(
        doctor(BASE_1290, RANGE_1290, RANGE_1290.replace(FOLLOW_UP_1290, from).replace(HEAD, to)),
        ASSESS_1290,
        ASSESS_1290.replace(HEAD, to),
      ),
      COVER_1290,
      COVER_1290.replaceAll(HEAD, to),
    );
  /** A bot-written history of `bodies`, newest first, a minute apart. */
  const historyOf = (bodies) => ({
    totalCount: bodies.length,
    nodes: bodies.map((diff, i) => ({
      editedAt: new Date(Date.UTC(2026, 9, 10, 12, 0) - i * 60_000).toISOString(),
      editor: BOT,
      deletedAt: null,
      diff,
    })),
  });
  const synthetic = (bodies) =>
    readSummary(connection([summaryNode(bodies[0], { userContentEdits: historyOf(bodies) })]), HEAD);
  const sha = (i) => String(i).padStart(2, "0").repeat(20);

  it("walks #1290's real history from 4d33e1f32 back to the approved 9fe7aa1a5 in one step", () => {
    const s = readSummary(real(1290), HEAD);
    expect(s.from).toBe(FOLLOW_UP_1290);
    // The 19:25:50 version carries an in-progress block, so the first earlier one that counts is 18:44:49's.
    expect(s.earlier[0]).toEqual({ from: APPROVED_1290, to: FOLLOW_UP_1290 });
    expect(rangeChain(s, APPROVED_1290)).toEqual({ reached: true, starts: [FOLLOW_UP_1290, APPROVED_1290] });
  });

  it("reaches #1322's review object directly: its recent review starts there", () => {
    const s = readSummary(real(1322), REAL[1322].head);
    expect(rangeChain(s, REVIEWED_1322)).toEqual({ reached: true, starts: [REVIEWED_1322] });
  });

  it("does not reach a commit nothing in the history reviewed up to, and lists every start it visited", () =>
    expect(rangeChain(readSummary(real(1290), HEAD), OTHER)).toEqual({
      reached: false,
      starts: [FOLLOW_UP_1290, APPROVED_1290, FIRST_1290],
    }));

  it("does not reach #1290's approval once the versions that reviewed up to 4d33e1f32 are gone", () => {
    const s = withHistory((h) => {
      h.nodes.splice(1, 2);
      h.totalCount = h.nodes.length;
    });
    expect(s.ok).toBe(true);
    expect(rangeChain(s, APPROVED_1290)).toEqual({ reached: false, starts: [FOLLOW_UP_1290] });
  });

  it("does not step through an earlier version that fails the rules", () => {
    const s = withHistory((h) => {
      h.nodes[2].diff = doctor(
        h.nodes[2].diff,
        "No actionable comments were generated in the recent review.",
        "Actionable comments posted: 1",
      );
    });
    expect(s.ok).toBe(true);
    expect(rangeChain(s, APPROVED_1290).reached).toBe(false);
  });

  it("steps only to versions strictly older than the one the step started from", () => {
    const [R, X, Y] = [sha(1), sha(2), sha(3)];
    // Newest first: the current review X..head, then a NEWER R..Y than the Y..X the walk steps to.
    const s = synthetic([versionOf(X, HEAD), versionOf(R, Y), versionOf(Y, X)]);
    expect(rangeChain(s, R)).toEqual({ reached: false, starts: [X, Y] });
    // The same versions in a consistent order reach R.
    expect(rangeChain(synthetic([versionOf(X, HEAD), versionOf(Y, X), versionOf(R, Y)]), R).reached).toBe(true);
  });

  it(`steps back at most ${MAX_CHAIN} versions`, () => {
    // Version i reviewed sha(i)..sha(i + 1); the current one sha(11)..head.
    const bodies = [versionOf(sha(11), HEAD)];
    for (let i = 10; i >= 0; i--) bodies.push(versionOf(sha(i), sha(i + 1)));
    const s = synthetic(bodies);
    expect(rangeChain(s, sha(1))).toMatchObject({ reached: true });
    expect(rangeChain(s, sha(1)).starts).toHaveLength(MAX_CHAIN + 1);
    expect(rangeChain(s, sha(0))).toMatchObject({ reached: false });
  });

  it("never reaches an anchor that is not a full sha", () => {
    const s = readSummary(real(1322), REAL[1322].head);
    expect(rangeChain(s, undefined).reached).toBe(false);
    expect(rangeChain({ ...s, from: "" }, "").reached).toBe(false);
  });
});
