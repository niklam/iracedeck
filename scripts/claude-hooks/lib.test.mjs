import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSyncShim } from "../lib/spawn-shim.mjs";
import {
  BOARD_MOVES,
  ghGraphql,
  graphqlArgs,
  memoizeBoardStatusField,
  moveBoardItemAfter,
  readIndexFile,
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
    18: null, // on the board with no Status set
  };
  const json = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
  const UNREADABLE = 19; // its card lookup fails in gh
  const ON_OLD_BOARD_ONLY = 20; // a card on users/niklam/projects/1 alone
  const ON_BOTH_BOARDS = 21; // a Done card there, a Backlog card on the org board
  const OWNER_UNREAD = 22; // a project 1 card whose owner gh could not name
  const calls = () => vi.mocked(spawnSync).mock.calls.map(([, args]) => args);
  const mutations = () => calls().filter((a) => a.some((x) => /mutation|item-edit/.test(x)));
  let mutationOk;
  beforeEach(() => {
    mutationOk = true;
    vi.mocked(spawnSync)
      .mockClear()
      .mockImplementation((cmd, args) => {
        if (args[0] === "project" && args[1] === "view") return json({ id: "PVT_board" });
        const q = args.find((a) => a.startsWith("query=")) ?? "";
        if (/updateProjectV2ItemPosition/.test(q))
          return mutationOk
            ? json({ data: { updateProjectV2ItemPosition: { clientMutationId: null } } })
            : { status: 1, stdout: "", stderr: "HTTP 403" };
        const n = Number(args.find((a) => a.startsWith("n="))?.slice(2));
        if (n === UNREADABLE) return { status: 1, stdout: "", stderr: "HTTP 502" };
        const card = (id, login, lane) => ({
          id,
          project: { number: 1, owner: { login } },
          fieldValueByName: lane && { name: lane },
        });
        const items = (nodes) => json({ data: { repository: { issue: { projectItems: { nodes } } } } });
        // #1799: the user board the org board replaced is project 1 too.
        if (n === ON_OLD_BOARD_ONLY) return items([card("PVTI_old", "niklam", "Backlog")]);
        if (n === ON_BOTH_BOARDS)
          return items([card("PVTI_old", "niklam", "Done"), card("PVTI_org", "IRaceDeck", "Backlog")]);
        if (n === OWNER_UNREAD)
          return items([
            { id: "PVTI_unread", project: { number: 1, owner: null }, fieldValueByName: { name: "Backlog" } },
          ]);
        if (!(n in lanes)) return items([]);
        return items([card(`PVTI_${n}`, "iracedeck", lanes[n])]);
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
  it("lets a card into Planned from Backlog or no lane only, never back from Next or later", () => {
    expect(BOARD_MOVES.Planned).toEqual(["(none)", "Backlog"]);
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    expect(setBoardStatus(10, "Planned", root)).toBe("board (dry run): would move #10 Backlog → Planned");
    expect(setBoardStatus(18, "Planned", root)).toBe("board (dry run): would move #18 (none) → Planned");
    for (const n of [11, 13, 14, 15, 17])
      expect(setBoardStatus(n, "Planned", root)).toMatch(/not moving it to Planned \(only from \(none\)\/Backlog\)/);
    expect(setBoardStatus(16, "Planned", root)).toBe("board: #16 already in Planned");
    expect(mutations()).toEqual([]);
  });

  // #1574 (CodeRabbit): a lookup gh could not answer is not "not on the board".
  it("tells a board gh could not read from a card that is not on it", () => {
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    const unread = /^board: could not read #19's card \(gh failed/;
    expect(setBoardStatus(UNREADABLE, "Planned", root)).toMatch(unread);
    expect(moveBoardItemAfter(UNREADABLE, null, root)).toMatch(unread);
    expect(moveBoardItemAfter(12, UNREADABLE, root)).toMatch(unread);
    expect(setBoardStatus(99, "Planned", root)).toBe("board: #99 is not on the Roadmap board");
    expect(mutations()).toEqual([]);
  });

  // #1799: both boards are project 1, so a card is the board's only when its owner is too.
  it("takes the org board's card, never the old user board's of the same number", () => {
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    expect(setBoardStatus(ON_OLD_BOARD_ONLY, "Planned", root)).toBe("board: #20 is not on the Roadmap board");
    expect(moveBoardItemAfter(ON_OLD_BOARD_ONLY, null, root)).toBe("board: #20 is not on the Roadmap board");
    expect(setBoardStatus(ON_BOTH_BOARDS, "Planned", root)).toBe("board (dry run): would move #21 Backlog → Planned");
    // A project 1 card whose owner is unreadable is a card gh could not read, not one that is absent.
    expect(setBoardStatus(OWNER_UNREAD, "Planned", root)).toMatch(/^board: could not read #22's card/);
    expect(mutations()).toEqual([]);
  });

  // #1574: with a raw lane edit refused, the release step's move needs the helper.
  it("lets a card into Done from Testing only", () => {
    expect(BOARD_MOVES.Done).toEqual(["Testing"]);
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "1");
    expect(setBoardStatus(13, "Done", root)).toBe("board (dry run): would move #13 Testing → Done");
    for (const n of [10, 11, 15, 16, 17, 18])
      expect(setBoardStatus(n, "Done", root)).toMatch(/not moving it to Done \(only from Testing\)/);
    expect(setBoardStatus(14, "Done", root)).toBe("board: #14 already in Done");
    expect(mutations()).toEqual([]);
  });

  it("moves a Backlog card into Planned through the Planned option, outside dry run", () => {
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "");
    const fake = vi.mocked(spawnSync).getMockImplementation();
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
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
    // #1799: the board is the organization's, and an issue also on the old user board moves its org card.
    const owned = calls().filter((x) => x[0] === "project" && x.includes("--owner"));
    expect(owned.length).toBeGreaterThan(0);
    for (const a of owned) expect(a[a.indexOf("--owner") + 1]).toBe("iracedeck");
    expect(setBoardStatus(ON_BOTH_BOARDS, "Planned", root)).toBe("board: #21 moved Backlog → Planned");
    const edits = calls().filter((a) => a[0] === "project" && a[1] === "item-edit");
    expect(edits.at(-1)).toEqual(expect.arrayContaining(["--id", "PVTI_org"]));
  });

  // #1574 second read: a hook moving fifteen cards read the project and its
  // field list fifteen times; the post-hook turns the memo on for its one run.
  it("reads the Status field once per process while the memo is on, and fresh otherwise", () => {
    vi.stubEnv("IRACEDECK_HOOKS_DRY_RUN", "");
    const fake = vi.mocked(spawnSync).getMockImplementation();
    let fieldListOk = true;
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      if (args[0] === "project" && args[1] === "field-list") {
        if (!fieldListOk) return { status: 1, stdout: "", stderr: "HTTP 502" };
        const options = ["Backlog", "Planned", "Next"].map((name) => ({ id: `opt_${name}`, name }));
        return json({ fields: [{ id: "PVTSSF_status", name: "Status", options }] });
      }
      if (args[0] === "project" && args[1] === "item-edit") return json({});
      return fake(cmd, args);
    });
    const fieldReads = () => calls().filter((a) => a[0] === "project" && /^(view|field-list)$/.test(a[1])).length;
    try {
      memoizeBoardStatusField();
      // A failed read is not remembered: the next move reads again.
      fieldListOk = false;
      expect(setBoardStatus(10, "Planned", root)).toMatch(/could not read the Status field/);
      fieldListOk = true;
      for (const n of [10, 18]) expect(setBoardStatus(n, "Planned", root)).toMatch(/moved .* → Planned/);
      expect(fieldReads()).toBe(4);
      memoizeBoardStatusField(false);
      expect(setBoardStatus(10, "Planned", root)).toMatch(/moved/);
      expect(fieldReads()).toBe(6);
    } finally {
      memoizeBoardStatusField(false);
    }
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
