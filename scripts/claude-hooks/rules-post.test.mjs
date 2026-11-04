import { describe, expect, it } from "vitest";

import {
  assignedGhRepo,
  editTargets,
  issueCreateRepos,
  issueNumberOfUrl,
  milestoneRemovedLine,
  setsMilestone,
} from "./rules-post.mjs";
import { programStart, trustedMask } from "./shell-lexer.mjs";

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

// #1606: the post-hook hands these readers the rewritten text, where every
// spelling of gh is `gh`, and slices the raw text where the program word starts.
describe("the post-hook's repository readers read every spelling of gh", () => {
  it.each(["gh", "gh.exe", `"gh"`, "/usr/bin/gh", `"C:/Program Files/GitHub CLI/gh.exe"`])(
    "issueCreateRepos reads %s issue create",
    (gh) => {
      const command = `${gh} issue create --title x -R Other/Repo && GH_REPO=a/b ${gh} issue create --title y`;
      expect(issueCreateRepos(command, trustedMask(command))).toEqual(["Other/Repo", "a/b"]);
    },
  );

  it("assignedGhRepo reads the GH_REPO ahead of a merge spelled with a path", () => {
    const command = `GH_REPO=a/b "C:/Program Files/GitHub CLI/gh.exe" pr merge 7 --squash`;
    const text = trustedMask(command);
    const at = programStart(command, text.indexOf("gh pr merge"));
    expect(at).toBe(command.indexOf('"C:'));
    expect(assignedGhRepo(command.slice(0, at), text.slice(0, at))).toBe("a/b");
  });
});
