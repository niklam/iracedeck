/**
 * The COMMITTED Elgato manifest carries no `Debug` key (#1338).
 *
 * `pnpm debug:plugin on` adds `"Debug": "--inspect=127.0.0.1:9229"` to the
 * manifest's `Nodejs` block on a developer's machine. The commit hook and
 * `pack:plugin` stop it from being recorded or packed; this is the third guard,
 * for a commit made without the hook. It reads the manifest from `HEAD`, never
 * from the working tree, so a local `on` keeps the suite green and only a
 * commit that carries the key turns it red.
 *
 * The check is proven against throwaway repositories: one whose HEAD carries
 * the key (it must report it), and one whose working copy carries it on a
 * clean HEAD (it must not).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEBUG_VALUE, ELGATO_MANIFEST, manifestDebug } from "./lib/debug-plugin.mjs";

const REPO = path.join(import.meta.dirname, "..");

/**
 * Runs git in `dir`. `MSYS_NO_PATHCONV` keeps Git for Windows from rewriting
 * the `HEAD:<path>` argument as a Windows path when this runs under an MSYS
 * shell's environment.
 */
function git(dir, ...args) {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr || r.error}`);
  return r.stdout;
}

/** The Elgato manifest's `Nodejs.Debug` state as committed at `HEAD` in `dir`. */
function committedDebug(dir) {
  return manifestDebug(git(dir, "show", `HEAD:${ELGATO_MANIFEST}`));
}

describe("the committed Elgato manifest", () => {
  it("carries no Debug key at HEAD", () => {
    const state = committedDebug(REPO);

    expect(state.ok, state.error).toBe(true);
    expect(
      state.present,
      `${ELGATO_MANIFEST} is committed with "Debug": ${JSON.stringify(state.value)} — run \`pnpm debug:plugin off\` and commit the manifest again.`,
    ).toBe(false);
  });
});

describe("the check reads HEAD, not the working tree", () => {
  const OFF = '{\n  "Nodejs": {\n    "Version": "24"\n  }\n}\n';
  const ON = OFF.replace('"24"\n', `"24",\n    "Debug": "${DEBUG_VALUE}"\n`);
  let dir;

  /** A throwaway repository with `committed` as the manifest at HEAD and `working` on disk. */
  function fixture(committed, working = committed) {
    dir = mkdtempSync(path.join(os.tmpdir(), "manifest-no-debug-"));
    const file = path.join(dir, ...ELGATO_MANIFEST.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(file, committed);
    git(dir, "add", "--", ELGATO_MANIFEST);
    git(dir, "commit", "-q", "--no-verify", "-m", "fixture");
    writeFileSync(file, working);
    return dir;
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports a key committed at HEAD — the case that must turn CI red", () => {
    expect(committedDebug(fixture(ON))).toEqual({ ok: true, present: true, value: DEBUG_VALUE });
  });

  it("ignores a key only in the working copy — a local `pnpm debug:plugin on` stays green", () => {
    expect(committedDebug(fixture(OFF, ON))).toEqual({ ok: true, present: false });
  });
});
