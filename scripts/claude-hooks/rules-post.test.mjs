import { describe, expect, it } from "vitest";

import { editTargets, issueNumberOfUrl, setsMilestone } from "./rules-post.mjs";

// #1574: the milestone trigger's pure half. The rest of rules-post.mjs is
// covered in rules-tools.test.mjs, where it was first tested.
const edit = (fields) => ({ issues: [], milestone: undefined, removesMilestone: false, repo: undefined, ...fields });

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
