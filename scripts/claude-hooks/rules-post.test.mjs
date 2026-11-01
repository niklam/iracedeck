import { describe, expect, it } from "vitest";

import { editTargets, issueNumberOfUrl, milestoneRemovedLine, setsMilestone } from "./rules-post.mjs";

// #1574: the milestone trigger's pure half. The rest of rules-post.mjs is
// covered in rules-tools.test.mjs, where it was first tested.
const edit = (fields) => ({
  issues: [],
  milestone: undefined,
  removesMilestone: false,
  repo: undefined,
  readable: true,
  namesMilestone: false,
  ...fields,
});

describe("setsMilestone", () => {
  it("is true for a milestone value, readable or not", () => {
    expect(setsMilestone(edit({ milestone: "3.8.0" }))).toBe(true);
    // An unreadable value may name one: the read-back settles it.
    expect(setsMilestone(edit({ milestone: null }))).toBe(true);
  });

  it("is false without one, for an empty one, and for a removal", () => {
    expect(setsMilestone(edit({}))).toBe(false);
    expect(setsMilestone(edit({ milestone: "" }))).toBe(false);
    expect(setsMilestone(edit({ removesMilestone: true }))).toBe(false);
    expect(setsMilestone(edit({ milestone: "3.8.0", removesMilestone: true }))).toBe(false);
  });

  // Second read: a milestone flag the parse could not reach still counts.
  it("is true for an edit it could not read whole whose text names a milestone flag", () => {
    expect(setsMilestone(edit({ readable: false, namesMilestone: true }))).toBe(true);
    expect(setsMilestone(edit({ readable: false, namesMilestone: false }))).toBe(false);
    expect(setsMilestone(edit({ readable: true, namesMilestone: true }))).toBe(false);
    expect(setsMilestone(edit({ readable: false, namesMilestone: true, removesMilestone: true }))).toBe(false);
    expect(setsMilestone(edit({ readable: false, namesMilestone: true, milestone: "" }))).toBe(false);
  });
});

describe("milestoneRemovedLine", () => {
  const tail =
    ": a card stays in its lane when its milestone goes, and moving it back to Backlog is Niklas's, in the board UI.";
  const removed = (fields) => edit({ removesMilestone: true, ...fields });
  const foreignUrl = "https://github.com/other/repo/issues/6";

  it("names the issues that may be iRaceDeck's", () => {
    expect(milestoneRemovedLine(removed({ issues: ["5", foreignUrl] }))).toBe(
      `gh issue edit removed the milestone of #5${tail}`,
    );
    expect(milestoneRemovedLine(removed({ issues: ["5"], repo: null }))).toBe(
      `gh issue edit removed the milestone of #5${tail}`,
    );
  });

  it("speaks of the issues it edited when it could not read them", () => {
    for (const fields of [{ readable: false }, {}, { issues: [foreignUrl], readable: false }])
      expect(milestoneRemovedLine(removed(fields)), JSON.stringify(fields)).toBe(
        `gh issue edit removed the milestone of the issues it edited${tail}`,
      );
  });

  it("says nothing when every issue is another repository's", () => {
    expect(milestoneRemovedLine(removed({ issues: ["5"], repo: "other/repo" }))).toBeUndefined();
    expect(milestoneRemovedLine(removed({ issues: ["5"] }), "other/repo")).toBeUndefined();
    expect(milestoneRemovedLine(removed({ issues: [foreignUrl] }))).toBeUndefined();
    expect(milestoneRemovedLine(removed({ issues: ["5"], readable: false, repo: "other/repo" }))).toBeUndefined();
  });
});

describe("editTargets", () => {
  const url = "https://github.com/other/repo/issues/7";

  it("takes an issue URL's own repository, then --repo, then GH_REPO", () => {
    expect(editTargets(edit({ issues: ["5", url] }), undefined)).toEqual([
      { ref: "5", repo: undefined },
      { ref: url, repo: "other/repo" },
    ]);
    expect(editTargets(edit({ issues: ["5", url], repo: "niklam/iracedeck" }), "x/y")).toEqual([
      { ref: "5", repo: "niklam/iracedeck" },
      { ref: url, repo: "other/repo" },
    ]);
    expect(editTargets(edit({ issues: ["5"] }), "git@github.com:Other/Repo.git")).toEqual([
      { ref: "5", repo: "Other/Repo" },
    ]);
  });

  it("is null for a repository named but not readable, wherever it was named", () => {
    expect(editTargets(edit({ issues: ["5"], repo: null }), "a/b")).toEqual([{ ref: "5", repo: null }]);
    expect(editTargets(edit({ issues: ["5"] }), null)).toEqual([{ ref: "5", repo: null }]);
    // An issue URL still says where it is.
    expect(editTargets(edit({ issues: [url], repo: null }), undefined)).toEqual([{ ref: url, repo: "other/repo" }]);
  });
});

describe("issueNumberOfUrl", () => {
  it("reads the number of an issue URL only", () => {
    expect(issueNumberOfUrl("https://github.com/niklam/iracedeck/issues/1574")).toBe(1574);
    expect(issueNumberOfUrl("https://github.com/niklam/iracedeck/pull/1574")).toBeUndefined();
    expect(issueNumberOfUrl(undefined)).toBeUndefined();
  });
});
