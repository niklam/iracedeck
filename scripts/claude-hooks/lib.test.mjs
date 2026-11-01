import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSyncShim } from "../lib/spawn-shim.mjs";
import { SUMMARY_OPENER } from "./coderabbit-summary.mjs";
import {
  baseChangedSince,
  BOARD_MOVES,
  ghGraphql,
  graphqlArgs,
  MAX_CONFLICTED_LINE_CHECKS,
  moveBoardItemAfter,
  prComments,
  readIndexFile,
  replayRebase,
  run,
  setBoardStatus,
  setHookDeadline,
  SPEC_DIR,
  specFilenames,
} from "./lib.mjs";

// `run()` routes between the two spawns. `spawnSync` stays real — the fixture
// repos below reach git through `run()` — except where the `run` tests stub it.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("../lib/spawn-shim.mjs", () => ({ spawnSyncShim: vi.fn() }));

const { spawnSync: realSpawnSync } = await vi.importActual("node:child_process");

let root;
const git = (...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "pipe" });
const writeSpec = (name, text = "# spec\n") => {
  mkdirSync(join(root, SPEC_DIR), { recursive: true });
  writeFileSync(join(root, SPEC_DIR, name), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-hooks-lib-"));
  git("init", "-q", "-b", "master");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// #1307: the merge gate's pure-rebase check, in real repositories. Each case
// builds M0, a reviewed branch off it, a moved base M1, and a head on M1.
// 20 s per case: real git subprocesses ran past the 5 s default under full-suite load (2026-10-10).
describe("replayRebase", { timeout: 20_000 }, () => {
  const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];
  const gitIn = (dir, ...args) =>
    execFileSync("git", [...ID, ...args], { cwd: dir, stdio: "pipe" })
      .toString()
      .trim();
  const lines = (edits = {}, n = 10) =>
    Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  const commit = (files, msg = "c") => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    git("add", "-A");
    git("commit", "-qm", msg);
    return gitIn(root, "rev-parse", "HEAD");
  };
  const replay = (reviewed, head, base) => replayRebase({ reviewed, head, base, dir: root });
  /** M0 → reviewed (line 2 of a.txt, a new c.txt); M0 → M1 (line 9 of a.txt). */
  const arrange = () => {
    const m0 = commit({ "a.txt": lines() }, "m0");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "a.txt": lines({ 2: "feature" }), "c.txt": "new\n" }, "reviewed");
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 9: "master moved" }) }, "m1");
    return { m0, reviewed, m1 };
  };
  const rebaseOnto = (base, ...picks) => {
    git("checkout", "-q", "-B", "rebased", base);
    for (const p of picks) git("cherry-pick", "--allow-empty", p);
    return gitIn(root, "rev-parse", "HEAD");
  };

  it("passes a clean rebase onto a moved base", () => {
    const { reviewed, m1 } = arrange();
    expect(replay(reviewed, rebaseOnto(m1, reviewed), m1)).toEqual({
      ok: true,
      differing: [],
      conflicted: [],
      lineMismatch: [],
    });
  });

  it("refuses a head that moves the reviewed line elsewhere — what the withdrawn line test accepted", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "-B", "moved", m1);
    const head = commit({ "a.txt": lines({ 7: "feature", 9: "master moved" }), "c.txt": "new\n" });
    expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, differing: ["a.txt"], conflicted: [] });
  });

  it("refuses a changed byte that a textconv driver would hide — trees compare by id", () => {
    commit({ ".gitattributes": "*.pdf diff=same\n", "a.txt": lines() }, "m0");
    git("config", "diff.same.textconv", "echo same");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "doc.pdf": "bytes A\n" });
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 9: "x" }) });
    git("checkout", "-q", "-B", "other", m1);
    const head = commit({ "doc.pdf": "bytes B\n" });
    expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, differing: ["doc.pdf"] });
  });

  /** M0 → reviewed inserts X after line 5; M0 → M1 inserts Y there: the rebase conflicts in a.txt. */
  const arrangeConflict = () => {
    commit({ "a.txt": lines() }, "m0");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "a.txt": lines({ 5: "line 5\nX" }) }, "reviewed");
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 5: "line 5\nY" }) }, "m1");
    git("checkout", "-q", "-B", "resolved", m1);
    return { reviewed, m1 };
  };

  it("reports a conflicted file whose resolution keeps the reviewed lines, for the gate to ask about", () => {
    const { reviewed, m1 } = arrangeConflict();
    const head = commit({ "a.txt": lines({ 5: "line 5\nY\nX" }) }, "resolved");
    expect(replay(reviewed, head, m1)).toEqual({
      ok: true,
      differing: ["a.txt"],
      conflicted: ["a.txt"],
      lineMismatch: [],
    });
  });

  it("marks a conflicted file whose resolution changed the reviewed lines", () => {
    const { reviewed, m1 } = arrangeConflict();
    const head = commit({ "a.txt": lines({ 5: "line 5\nY\nX2" }) }, "resolved");
    expect(replay(reviewed, head, m1)).toMatchObject({ conflicted: ["a.txt"], lineMismatch: ["a.txt"] });
  });

  it("refuses a follow-up commit on top of the reviewed one before any replay", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "feature");
    const head = commit({ "c.txt": "changed\n" }, "follow-up");
    expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, followUp: 1 });
  });

  it("passes the base merged into the branch — an 'Update branch' merge is a rebase by other means", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", m1);
    // toEqual: a `followUp` the base's own commit put there must not hide behind a partial match.
    expect(replay(reviewed, gitIn(root, "rev-parse", "HEAD"), m1)).toEqual({
      ok: true,
      differing: [],
      conflicted: [],
      lineMismatch: [],
    });
  });

  it("passes a clean rebase of a multi-commit branch, compared against its tip", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "feature");
    const tip = commit({ "d.txt": "second\n" }, "second");
    expect(replay(tip, rebaseOnto(m1, reviewed, tip), m1)).toMatchObject({ ok: true, differing: [] });
  });

  it("is not fooled by a replace ref in the checkout", () => {
    const { reviewed, m1 } = arrange();
    const cleanHead = rebaseOnto(m1, reviewed);
    git("checkout", "-q", "-B", "moved", m1);
    const badHead = commit({ "a.txt": lines({ 7: "feature", 9: "master moved" }), "c.txt": "new\n" });
    git("replace", badHead, cleanHead);
    expect(replay(reviewed, badHead, m1)).toMatchObject({ differing: ["a.txt"] });
  });

  it("fetches a reviewed commit that only origin has", () => {
    const { m1 } = arrange();
    const remote = mkdtempSync(join(tmpdir(), "ird-hooks-origin-"));
    const other = mkdtempSync(join(tmpdir(), "ird-hooks-other-"));
    try {
      gitIn(remote, "init", "-q", "--bare");
      git("remote", "add", "origin", remote);
      git("push", "-q", "origin", "master");
      gitIn(other, "clone", "-q", remote, ".");
      gitIn(other, "checkout", "-q", "-b", "pushed", `${m1}~1`);
      writeFileSync(join(other, "e.txt"), "from elsewhere\n");
      gitIn(other, "add", "-A");
      gitIn(other, "commit", "-qm", "reviewed elsewhere");
      gitIn(other, "push", "-q", "origin", "pushed");
      const reviewed = gitIn(other, "rev-parse", "HEAD");
      expect(() => gitIn(root, "cat-file", "-e", `${reviewed}^{commit}`)).toThrow();
      git("checkout", "-q", "-B", "rebased", m1);
      const head = commit({ "e.txt": "from elsewhere\n" }, "rebased");
      expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, differing: [] });
      expect(() => git("rev-parse", "-q", "--verify", "FETCH_HEAD")).toThrow();
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("fails, never passes, for a commit git cannot find or fetch, a non-sha, or a spent deadline", () => {
    const { reviewed, m1 } = arrange();
    expect(replay("f".repeat(40), reviewed, m1)).toMatchObject({ ok: false });
    expect(replay("HEAD", reviewed, m1)).toMatchObject({ ok: false });
    setHookDeadline(Date.now() - 1);
    try {
      expect(replay(reviewed, reviewed, m1)).toEqual({ ok: false, reason: "the hook ran out of time" });
    } finally {
      setHookDeadline(Infinity);
    }
  });

  it("reports a modify/delete conflict kept as the reviewed file, which no tree difference shows", () => {
    commit({ "old.sh": lines(), "a.txt": "a\n" }, "m0");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "old.sh": lines({ 3: "reviewed edit" }) }, "reviewed");
    git("checkout", "-q", "master");
    git("rm", "-q", "old.sh");
    git("commit", "-qm", "m1 deletes old.sh");
    const m1 = gitIn(root, "rev-parse", "HEAD");
    git("checkout", "-q", "-B", "kept", m1);
    const head = commit({ "old.sh": lines({ 3: "reviewed edit" }) }, "kept");
    expect(replay(reviewed, head, m1)).toEqual({
      ok: true,
      differing: [],
      conflicted: ["old.sh"],
      lineMismatch: ["old.sh"],
    });
  });

  it("compares a rename's source, so a base fix to it cannot vanish into the target", () => {
    commit({ "f.txt": lines() }, "m0");
    git("checkout", "-q", "-b", "feature");
    git("mv", "f.txt", "g.txt");
    const reviewed = commit({ "g.txt": lines({ 10: "edited" }) }, "rename");
    git("checkout", "-q", "master");
    const m1 = commit({ "f.txt": lines({ 3: "security fix" }) }, "m1 fixes f");
    git("checkout", "-q", "-B", "theirs", m1);
    git("rm", "-q", "f.txt");
    const head = commit({ "g.txt": lines({ 10: "edited" }) }, "rebased, fix dropped");
    const v = replay(reviewed, head, m1);
    expect(v.ok).toBe(true);
    expect(v.conflicted).toContain("f.txt");
    expect(v.lineMismatch).toContain("f.txt");
  });

  it("refuses criss-cross history, where git would pick one of several merge-bases", () => {
    commit({ "a.txt": lines() }, "m0");
    git("checkout", "-q", "-b", "x");
    const x1 = commit({ "x.txt": "x\n" }, "x1");
    git("checkout", "-q", "master");
    const y1 = commit({ "y.txt": "y\n" }, "y1");
    git("merge", "-q", "--no-edit", x1);
    const base = gitIn(root, "rev-parse", "HEAD");
    git("checkout", "-q", "x");
    git("merge", "-q", "--no-edit", y1);
    const reviewed = commit({ "c.txt": "c\n" }, "reviewed");
    expect(replay(reviewed, reviewed, base)).toEqual({
      ok: false,
      reason: "the history is criss-crossed (more than one merge-base)",
    });
  });

  it("runs from the repository root whatever directory the session is in", () => {
    mkdirSync(join(root, "sub"));
    commit({ "a.txt": lines(), "sub/keep.txt": "k\n" }, "m0");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "a.txt": lines({ 5: "line 5\nX" }) }, "reviewed");
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 5: "line 5\nY" }) }, "m1");
    git("checkout", "-q", "-B", "resolved", m1);
    const head = commit({ "a.txt": lines({ 5: "line 5\nY\nX" }) }, "resolved");
    expect(replayRebase({ reviewed, head, base: m1, dir: join(root, "sub") })).toEqual({
      ok: true,
      differing: ["a.txt"],
      conflicted: ["a.txt"],
      lineMismatch: [],
    });
  });

  it("refuses rather than line-check more conflicted files than the deadline allows", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_CONFLICTED_LINE_CHECKS + 1 }, (_, i) => [`f${i}.txt`, lines()]),
    );
    commit(many, "m0");
    git("checkout", "-q", "-b", "feature");
    const mine = Object.fromEntries(Object.keys(many).map((f) => [f, lines({ 2: "mine" })]));
    const reviewed = commit(mine, "reviewed");
    git("checkout", "-q", "master");
    const m1 = commit(Object.fromEntries(Object.keys(many).map((f) => [f, lines({ 2: "theirs" })])), "m1");
    expect(replay(reviewed, m1, m1)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/more than the line check reads/),
    });
  });

  it("ignores grafts and replace refs, whatever the hook's environment holds", () => {
    const { reviewed, m1 } = arrange();
    vi.mocked(spawnSync).mockClear();
    replay(reviewed, rebaseOnto(m1, reviewed), m1);
    const gitEnvs = vi
      .mocked(spawnSync)
      .mock.calls.filter(([c]) => c === "git")
      .map(([, , o]) => o.env);
    expect(gitEnvs.length).toBeGreaterThan(3);
    for (const env of gitEnvs) {
      expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(env.GIT_GRAFT_FILE).toBeTruthy();
    }
  });
});

// #1307: the base moving under a PR — a retarget or a base force-push — since a review.
describe("baseChangedSince", () => {
  const answer = (nodes) =>
    vi.mocked(spawnSync).mockImplementationOnce(() => ({
      status: 0,
      stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes } } } } }),
      stderr: "",
    }));

  it("asks GitHub for both a retarget and a base force-push", () => {
    answer([]);
    baseChangedSince(7, "2026-10-03T10:00:00Z", root);
    const [cmd, args] = vi.mocked(spawnSync).mock.calls.at(-1);
    expect(cmd).toBe("gh");
    const query = args.find((a) => a.startsWith("query="));
    expect(query).toMatch(/itemTypes:\[BASE_REF_CHANGED_EVENT,BASE_REF_FORCE_PUSHED_EVENT\]/);
    expect(query).toMatch(/on BaseRefChangedEvent\{createdAt\}/);
    expect(query).toMatch(/on BaseRefForcePushedEvent\{createdAt\}/);
    expect(args).toContain("n=7");
  });

  it("is true only for an event after the review", () => {
    answer([{ createdAt: "2026-10-03T09:00:00Z" }]);
    expect(baseChangedSince(7, "2026-10-03T10:00:00Z", root)).toBe(false);
    answer([{ createdAt: "2026-10-03T09:00:00Z" }, { createdAt: "2026-10-03T11:00:00Z" }]);
    expect(baseChangedSince(7, "2026-10-03T10:00:00Z", root)).toBe(true);
  });

  it("is undefined — which the gate reads as yes — when gh cannot answer", () => {
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 1, stdout: "", stderr: "HTTP 502" }));
    expect(baseChangedSince(7, "2026-10-03T10:00:00Z", root)).toBeUndefined();
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 0, stdout: "{}", stderr: "" }));
    expect(baseChangedSince(7, "2026-10-03T10:00:00Z", root)).toBeUndefined();
  });
});

// #1386 review: one GraphQL helper for every merge-gate read.
describe("graphqlArgs and ghGraphql", () => {
  const answer = (out, status = 0) =>
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status, stdout: JSON.stringify(out), stderr: "" }));

  it("passes the repository as gh's placeholders, a number typed and a string raw", () =>
    expect(graphqlArgs("query{x}", { n: 7, id: "@IC_kwDO" })).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query{x}",
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      "n=7",
      "-f",
      "id=@IC_kwDO",
    ]));

  it("unwraps `data`, and answers undefined for a failure, an error list or no data", () => {
    answer({ data: { a: 1 } });
    expect(ghGraphql("q", {}, root)).toEqual({ a: 1 });
    answer({ data: { a: 1 }, errors: [{ message: "partial" }] });
    expect(ghGraphql("q", {}, root)).toBeUndefined();
    answer({});
    expect(ghGraphql("q", {}, root)).toBeUndefined();
    answer({ data: { a: 1 } }, 1);
    expect(ghGraphql("q", {}, root)).toBeUndefined();
  });
});

describe("prComments", () => {
  const BOT = { login: "coderabbitai", __typename: "Bot" };
  const summary = { id: "IC_summary", author: BOT, body: `${SUMMARY_OPENER}\nbody` };
  const other = { id: "IC_other", author: BOT, body: "<!-- This is an auto-generated reply by CodeRabbit -->" };
  const page = (nodes) => ({
    data: { repository: { pullRequest: { comments: { totalCount: nodes.length, pageInfo: {}, nodes } } } },
  });
  const edits = { totalCount: 1, nodes: [{ editedAt: "t", editor: BOT, deletedAt: null, diff: "body" }] };
  const answer = (out) =>
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 0, stdout: JSON.stringify(out), stderr: "" }));

  it("reads the comments, then the one summary's whole edit history by its id", () => {
    vi.mocked(spawnSync).mockClear();
    answer(page([other, { ...summary }]));
    answer({ data: { node: { userContentEdits: edits } } });
    const c = prComments(7, root);
    expect(c.nodes[1].userContentEdits).toEqual(edits);
    expect(c.nodes[0].userContentEdits).toBeUndefined();
    const [first, second] = vi.mocked(spawnSync).mock.calls.map(([, args]) => args);
    expect(first).toContain("n=7");
    expect(first.find((a) => a.startsWith("query="))).toMatch(/nodes\{id author/);
    expect(second).toContain("id=IC_summary");
    // GitHub refuses a declared variable the query does not use, which the first live run hit.
    expect(second.find((a) => a.startsWith("query="))).toMatch(/^query=query\(\$id:ID!\)\{node/);
    expect(second.find((a) => a.startsWith("query="))).toMatch(
      /userContentEdits\(last:100\)\{totalCount nodes\{editedAt editor\{login __typename\} deletedAt diff\}\}/,
    );
  });

  it("reads no history when there is not exactly one summary, and leaves it off when that read fails", () => {
    vi.mocked(spawnSync).mockClear();
    answer(page([other]));
    expect(prComments(7, root).nodes[0].userContentEdits).toBeUndefined();
    answer(page([{ ...summary }, { ...summary, id: "IC_2" }]));
    prComments(7, root);
    expect(vi.mocked(spawnSync).mock.calls).toHaveLength(2);
    answer(page([{ ...summary }]));
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 1, stdout: "", stderr: "HTTP 502" }));
    expect(prComments(7, root).nodes[0].userContentEdits).toBeUndefined();
  });
});

describe("the hook-wide deadline", () => {
  afterEach(() => setHookDeadline(Infinity));

  it("clamps every spawn to what is left of it, gh included", () => {
    setHookDeadline(Date.now() + 5_000);
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 0, stdout: "", stderr: "" }));
    run("gh", ["--version"], { timeoutMs: 45_000 });
    expect(vi.mocked(spawnSync).mock.calls.at(-1)[2].timeout).toBeLessThanOrEqual(5_000);
  });

  it("never lets a credential prompt hold the hook", () => {
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 0, stdout: "", stderr: "" }));
    run("git", ["fetch", "origin"]);
    const env = vi.mocked(spawnSync).mock.calls.at(-1)[2].env;
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.GCM_INTERACTIVE).toBe("never");
  });

  it("starts nothing once it is spent", () => {
    setHookDeadline(Date.now() - 1);
    vi.mocked(spawnSync).mockClear();
    expect(run("git", ["status"])).toMatchObject({ ok: false });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

// #1520: the PO orders its milestone's cards in Next. Every gh call is answered
// by a fake that routes on the arguments, so nothing reaches the real board.
describe("the board's Next lane and positions", () => {
  const lanes = {
    10: "Backlog",
    11: "Next",
    12: "Next",
    13: "Testing",
    14: "Done",
    15: "In progress",
    16: "Planned",
    17: "Dropped",
  };
  const calls = () => vi.mocked(spawnSync).mock.calls.map(([, args]) => args);
  const mutations = () => calls().filter((a) => a.some((x) => /mutation|item-edit/.test(x)));
  let mutationOk;
  beforeEach(() => {
    mutationOk = true;
    vi.mocked(spawnSync)
      .mockClear()
      .mockImplementation((cmd, args) => {
        const json = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
        if (args[0] === "project" && args[1] === "view") return json({ id: "PVT_board" });
        const q = args.find((a) => a.startsWith("query=")) ?? "";
        if (/updateProjectV2ItemPosition/.test(q))
          return mutationOk
            ? json({ data: { updateProjectV2ItemPosition: { clientMutationId: null } } })
            : { status: 1, stdout: "", stderr: "HTTP 403" };
        const n = Number(args.find((a) => a.startsWith("n="))?.slice(2));
        if (!(n in lanes)) return json({ data: { repository: { issue: { projectItems: { nodes: [] } } } } });
        const node = { id: `PVTI_${n}`, project: { number: 1 }, fieldValueByName: { name: lanes[n] } };
        return json({ data: { repository: { issue: { projectItems: { nodes: [node] } } } } });
      });
  });
  afterEach(() => {
    vi.mocked(spawnSync).mockImplementation(realSpawnSync);
    vi.unstubAllEnvs();
  });

  it("drops a card from any lane before Testing, never a merged or shipped one", () => {
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    for (const n of [10, 11, 15, 16])
      expect(setBoardStatus(n, "Dropped", root)).toMatch(/would move #\d+ .+ → Dropped/);
    for (const n of [13, 14]) expect(setBoardStatus(n, "Dropped", root)).toMatch(/not moving it to Dropped/);
    expect(setBoardStatus(17, "Dropped", root)).toBe("board: #17 already in Dropped");
    expect(mutations()).toEqual([]);
  });

  it("lets a card into Next from Backlog and Planned only, and still out of Next forwards", () => {
    expect(BOARD_MOVES.Next).toEqual(["(none)", "Backlog", "Planned"]);
    expect(BOARD_MOVES["In progress"]).toContain("Next");
    expect(BOARD_MOVES.Testing).toContain("Next");
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    expect(setBoardStatus(10, "Next", root)).toBe("board (dry run): would move #10 Backlog → Next");
    expect(setBoardStatus(16, "Next", root)).toMatch(/would move #16 Planned → Next/);
    for (const n of [13, 14, 15]) expect(setBoardStatus(n, "Next", root)).toMatch(/not moving it to Next/);
    expect(mutations()).toEqual([]);
  });

  // #1574: Niklas decides what is Planned and an agent carries it out, never
  // pulling a card back into Planned from Next or later.
  it("lets a card into Planned from Backlog only, never back from Next or later", () => {
    expect(BOARD_MOVES.Planned).toEqual(["(none)", "Backlog"]);
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    expect(setBoardStatus(10, "Planned", root)).toBe("board (dry run): would move #10 Backlog → Planned");
    for (const n of [11, 13, 14, 15, 17])
      expect(setBoardStatus(n, "Planned", root)).toMatch(/not moving it to Planned \(only from \(none\)\/Backlog\)/);
    expect(setBoardStatus(16, "Planned", root)).toBe("board: #16 already in Planned");
    expect(mutations()).toEqual([]);
  });

  it("moves a Backlog card into Planned through the Planned option, outside dry run", () => {
    const fake = vi.mocked(spawnSync).getMockImplementation();
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const json = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
      if (args[0] === "project" && args[1] === "field-list") {
        const options = ["Backlog", "Planned", "Next"].map((name) => ({ id: `opt_${name}`, name }));
        return json({ fields: [{ id: "PVTSSF_status", name: "Status", options }] });
      }
      if (args[0] === "project" && args[1] === "item-edit") return json({});
      return fake(cmd, args);
    });
    expect(setBoardStatus(10, "Planned", root)).toBe("board: #10 moved Backlog → Planned");
    const edit = calls().find((a) => a[0] === "project" && a[1] === "item-edit");
    expect(edit).toEqual(expect.arrayContaining(["--id", "PVTI_10", "--single-select-option-id", "opt_Planned"]));
  });

  describe("moveBoardItemAfter, under dry run", () => {
    beforeEach(() => vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1"));
    it("puts a card at the top of its lane for a null after", () =>
      expect(moveBoardItemAfter(12, null, root)).toBe("board (dry run): would move #12 to the top of Next"));
    it("puts a card after another card in its lane", () =>
      expect(moveBoardItemAfter(12, 11, root)).toBe("board (dry run): would move #12 after #11 in Next"));
    it("never moves a card in Testing, Done or Dropped", () => {
      expect(moveBoardItemAfter(13, null, root)).toMatch(/#13 is in Testing; its position is not moved/);
      expect(moveBoardItemAfter(14, 13, root)).toMatch(/#14 is in Done; its position is not moved/);
      expect(moveBoardItemAfter(17, null, root)).toMatch(/#17 is in Dropped; its position is not moved/);
    });
    it("refuses an anchor in another lane, off the board, or the card itself", () => {
      expect(moveBoardItemAfter(12, 10, root)).toMatch(/#10 is in Backlog, not Next/);
      expect(moveBoardItemAfter(12, 99, root)).toMatch(/#99 is not on the Roadmap board/);
      expect(moveBoardItemAfter(99, null, root)).toMatch(/#99 is not on the Roadmap board/);
      expect(moveBoardItemAfter(12, 12, root)).toMatch(/after itself/);
    });
    it("sends no mutation at all", () => {
      moveBoardItemAfter(12, null, root);
      moveBoardItemAfter(12, 11, root);
      expect(mutations()).toEqual([]);
    });
  });

  describe("moveBoardItemAfter, live (against the fake)", () => {
    const sent = () =>
      mutations().map((a) => Object.fromEntries(a.filter((x) => /^\w+=/.test(x)).map((x) => x.split(/=(.*)/s))));
    it("sends no afterId for the top, and the anchor's item id otherwise", () => {
      expect(moveBoardItemAfter(12, null, root)).toBe("board: #12 moved to the top of Next");
      expect(moveBoardItemAfter(12, 11, root)).toBe("board: #12 moved after #11 in Next");
      const [top, after] = sent();
      expect(top).toMatchObject({ project: "PVT_board", item: "PVTI_12" });
      expect(top.query).not.toMatch(/afterId/);
      expect(top.after).toBeUndefined();
      expect(after).toMatchObject({ project: "PVT_board", item: "PVTI_12", after: "PVTI_11" });
      expect(after.query).toMatch(/afterId:\$after/);
    });
    it("reports a refused mutation", () => {
      mutationOk = false;
      expect(moveBoardItemAfter(12, null, root)).toMatch(/moving #12 to the top of Next failed/);
    });
  });
});

// #1193 review: the worktree gate asks "is there a spec for #n on master?",
// and the local working tree answers a different question in both directions.
describe("specFilenames", () => {
  it("lists what origin/master carries, not what the working tree holds", () => {
    writeSpec("2026-01-01-issue-7-on-master.md");
    git("add", "-A");
    git("commit", "-qm", "spec");
    git("update-ref", "refs/remotes/origin/master", "HEAD");
    // A spec pushed to master that this checkout has not pulled is modelled by
    // deleting the file locally; one written here and never committed, by adding one.
    unlinkSync(join(root, SPEC_DIR, "2026-01-01-issue-7-on-master.md"));
    writeSpec("2026-01-02-issue-8-uncommitted.md");
    expect(specFilenames(root)).toEqual(["2026-01-01-issue-7-on-master.md"]);
  });

  it("falls back to the working tree when there is no origin/master to ask", () => {
    writeSpec("2026-01-02-issue-8-local.md");
    expect(specFilenames(root)).toEqual(["2026-01-02-issue-8-local.md"]);
  });

  it("is empty — the side that asks — when neither can answer", () => {
    expect(specFilenames(root)).toEqual([]);
  });
});

// #1193 review (CodeRabbit): a plain commit takes the STAGED bytes.
describe("readIndexFile", () => {
  const rel = `${SPEC_DIR}2026-01-01-issue-7-a.md`;
  it("returns what is staged, not the edit made after staging", () => {
    writeSpec("2026-01-01-issue-7-a.md", "staged\n");
    git("add", "-A");
    writeSpec("2026-01-01-issue-7-a.md", "edited\n");
    expect(readIndexFile(root, rel)).toBe("staged\n");
  });

  it("is undefined — the side that passes — for a path the index does not hold", () => {
    writeSpec("2026-01-01-issue-7-a.md");
    expect(readIndexFile(root, rel)).toBeUndefined();
  });
});

// #1149: `.exe` binaries spawn directly, anything else is a `.cmd` shim and goes
// through the shared helper (no args array beside `shell: true`).
describe("run", () => {
  const done = { status: 0, stdout: "out", stderr: "" };

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset().mockReturnValue(done);
    vi.mocked(spawnSyncShim).mockReset().mockReturnValue(done);
  });

  afterEach(() => {
    vi.mocked(spawnSync).mockReset().mockImplementation(realSpawnSync);
  });

  it.each(["git", "gh", "node"])("spawns %s directly", (cmd) => {
    expect(run(cmd, ["--version"])).toEqual({ ok: true, out: "out", err: "", code: 0 });
    expect(spawnSync).toHaveBeenCalledWith(cmd, ["--version"], expect.objectContaining({ encoding: "utf8" }));
    expect(spawnSyncShim).not.toHaveBeenCalled();
  });

  it("sends a shim through the shared helper", () => {
    expect(run("pnpm", ["generate:action-comms"]).ok).toBe(true);
    expect(spawnSyncShim).toHaveBeenCalledWith("pnpm", ["generate:action-comms"], expect.any(Object));
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("spawns another .exe directly with shim: false", () => {
    run("powershell", ["-NoProfile"], { shim: false });
    expect(spawnSync).toHaveBeenCalledWith("powershell", ["-NoProfile"], expect.any(Object));
    expect(spawnSyncShim).not.toHaveBeenCalled();
  });

  it("returns a failed run, not a throw, for an argument the helper refuses", () => {
    vi.mocked(spawnSyncShim).mockImplementation(() => {
      throw new TypeError("Cannot pass through cmd.exe intact.");
    });
    expect(run("pnpm", ["50%"])).toEqual({
      ok: false,
      out: "",
      err: "Cannot pass through cmd.exe intact.",
      code: null,
    });
  });
});
