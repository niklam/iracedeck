/**
 * The between-releases voice-pack publish deploys only the catalog it verified,
 * and only from master (#1392).
 *
 * `publish-voice-packs.yml` with `publish` on packs and verifies every pack at
 * the commit it checked out, publishes the archives, then calls
 * `firebase-hosting-release.yml` to overlay that catalog onto the latest stable
 * tag and deploy it. Three things keep the live `voice-catalog.json` honest,
 * and nothing else goes red when one of them goes:
 *
 * - the deploy is handed `github.sha`, the commit `pack` verified, never the
 *   branch, whose tip can carry an entry nobody verified;
 * - the overlay refuses unless master's catalog is still that commit's catalog,
 *   since a re-run keeps its original commit and would otherwise put an older
 *   catalog back live;
 * - a publishing dispatch from any ref but master fails before anything runs.
 *
 * The two shell steps are run for real, extracted from the YAML, against
 * throwaway git repositories: the overlay against a shallow tag checkout and an
 * `origin` it fetches commits from by sha, as on GitHub.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = path.join(import.meta.dirname, "..");
const PUBLISH_WORKFLOW = ".github/workflows/publish-voice-packs.yml";
const HOSTING_WORKFLOW = ".github/workflows/firebase-hosting-release.yml";
const GUARD_STEP = "Refuse to publish from a ref other than master";
const OVERLAY_STEP = "Overlay the voice-pack catalog from another ref";
const CATALOG = "packages/audio-assets/catalog";

const readWorkflow = (rel) => parse(readFileSync(path.join(REPO, rel), "utf8"));

/** The step called `name` in `job`, or a failure naming what is missing. */
function stepNamed(doc, job, name) {
  const steps = doc?.jobs?.[job]?.steps ?? [];
  const index = steps.findIndex((s) => s?.name === name);
  if (index === -1) throw new Error(`job "${job}" has no step named "${name}"`);
  return { step: steps[index], index };
}

/**
 * A bash that runs the steps as the runner would. On Windows that is Git's own
 * bash, found from git's exec path: a bare `bash` there can be WSL's, which
 * sees a different filesystem and a different git. Undefined when none is
 * found, which the first test below turns red rather than letting the
 * behavioural tests skip in silence.
 */
function findBash() {
  if (process.platform !== "win32") return "bash";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (git.status !== 0) return undefined;
  const gitRoot = path.resolve(git.stdout.trim(), "..", "..", "..");
  return [path.join(gitRoot, "bin", "bash.exe"), path.join(gitRoot, "usr", "bin", "bash.exe")].find(existsSync);
}

const BASH = findBash();

it("finds a bash to run the workflow steps with", () => {
  expect(BASH, "no bash found (on Windows: Git for Windows' bin/bash.exe beside git)").toBeDefined();
});

let work;
let isolatedEnv;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "ird-voice-publish-"));
  const emptyConfig = path.join(work, "empty.gitconfig");
  writeFileSync(emptyConfig, "");
  // No user, system or hook configuration of the machine running the suite.
  isolatedEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Writes `script` to a file and runs it with bash in `cwd`. */
function runStep(script, cwd, env) {
  const file = path.join(work, `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, script);
  const result = spawnSync(BASH, [file.replaceAll("\\", "/")], {
    cwd,
    env: { ...isolatedEnv, ...env },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("publish-voice-packs.yml (#1392)", () => {
  const doc = readWorkflow(PUBLISH_WORKFLOW);

  it("deploys the commit pack verified, never the branch", () => {
    expect(doc.jobs["deploy-website"].with.catalog_ref).toBe("${{ github.sha }}");
  });

  it("deploys only a publish dispatched from master", () => {
    expect(doc.jobs["deploy-website"].if).toBe("inputs.publish && github.ref == 'refs/heads/master'");
  });

  it("runs the master guard first in the pack job, for a publish only, in bash", () => {
    const { step, index } = stepNamed(doc, "pack", GUARD_STEP);
    expect(index).toBe(0);
    expect(step.if).toBe("inputs.publish");
    // The pack job runs on Windows, whose default shell is pwsh.
    expect(step.shell).toBe("bash");
    expect(step.env).toEqual({ DISPATCHED_REF: "${{ github.ref }}" });
    expect(step.run).not.toContain("${{");
  });
});

describe.skipIf(BASH === undefined)("the master guard step, run", () => {
  const { step } = stepNamed(readWorkflow(PUBLISH_WORKFLOW), "pack", GUARD_STEP);
  const guard = (ref) => runStep(step.run, work, { DISPATCHED_REF: ref });

  it("passes a dispatch from master", () => {
    const { status, output } = guard("refs/heads/master");
    expect(output).toContain("Publishing from refs/heads/master.");
    expect(status).toBe(0);
  });

  it.each(["refs/heads/fix/1392-voice-pack-publish-ref", "refs/heads/release/3.8", "refs/tags/v3.8.0", ""])(
    "refuses a dispatch from %j",
    (ref) => {
      const { status, output } = guard(ref);
      expect(output).toContain("::error::Voice packs are published from master only");
      expect(status).toBe(1);
    },
  );
});

describe(`${HOSTING_WORKFLOW}'s overlay step (#1392)`, () => {
  it("runs only for a caller that names a catalog commit, and reads it from the environment", () => {
    const { step } = stepNamed(readWorkflow(HOSTING_WORKFLOW), "build_and_deploy", OVERLAY_STEP);
    expect(step.if).toBe("inputs.catalog_ref");
    expect(step.env).toEqual({ CATALOG_REF: "${{ inputs.catalog_ref }}" });
    expect(step.run).not.toContain("${{");
  });

  it("deploys one run at a time and never cancels one in flight, so a check is not overtaken by an older deploy", () => {
    expect(readWorkflow(HOSTING_WORKFLOW).jobs.build_and_deploy.concurrency).toEqual({
      group: "firebase-hosting-live",
      "cancel-in-progress": false,
    });
  });
});

describe.skipIf(BASH === undefined)("the overlay step, run against a fetched origin", () => {
  const { step } = stepNamed(readWorkflow(HOSTING_WORKFLOW), "build_and_deploy", OVERLAY_STEP);
  let origin;
  const sha = {};

  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env: isolatedEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (root, rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const commit = (message) => {
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", message);
    return git(origin, "rev-parse", "HEAD");
  };

  /**
   * origin's master:  tag ── catalog ── unrelated   (tip)
   * side branches:    stale (off catalog: the catalog moved on master since)
   *                   no-catalog (off unrelated: the catalog deleted)
   */
  beforeAll(() => {
    origin = path.join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "master");
    // GitHub serves any reachable commit by sha; a local upload-pack does not by default.
    git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");

    write(origin, "scripts/lib/voice-catalog-data.mjs", "export {};\n");
    write(origin, `${CATALOG}/default.json`, '{"version":"1.0.0"}\n');
    write(origin, `${CATALOG}/withdrawn.json`, '{"version":"1.0.0"}\n');
    write(origin, "site.txt", "released site\n");
    sha.tag = commit("the stable release");
    git(origin, "tag", "v1.0.0");

    write(origin, `${CATALOG}/default.json`, '{"version":"1.1.0"}\n');
    rmSync(path.join(origin, CATALOG, "withdrawn.json"));
    sha.catalog = commit("bump default, withdraw a pack");

    write(origin, "site.txt", "unreleased docs\n");
    sha.unrelated = commit("unrelated master work");

    git(origin, "checkout", "-q", "-b", "stale", sha.catalog);
    write(origin, `${CATALOG}/default.json`, '{"version":"1.2.0"}\n');
    sha.stale = commit("an entry master never took");

    git(origin, "checkout", "-q", "-b", "no-catalog", sha.unrelated);
    rmSync(path.join(origin, CATALOG), { recursive: true });
    sha.noCatalog = commit("no catalog");

    git(origin, "checkout", "-q", "master");
  });

  /** A shallow checkout of the stable tag, as actions/checkout leaves it, with the step run in it. */
  function overlay(catalogRef, { dropGenerator = false } = {}) {
    const checkout = path.join(work, `checkout-${Math.random().toString(36).slice(2)}`);
    git(work, "clone", "-q", "--depth=1", "--branch", "v1.0.0", pathToFileURL(origin).href, checkout);
    if (dropGenerator) rmSync(path.join(checkout, "scripts/lib/voice-catalog-data.mjs"));
    const run = runStep(step.run, checkout, { CATALOG_REF: catalogRef });
    const read = (rel) =>
      existsSync(path.join(checkout, rel)) ? readFileSync(path.join(checkout, rel), "utf8") : null;
    return { ...run, read };
  }

  it("overlays the verified commit's catalog while master's is the same, withdrawals included", () => {
    const { status, output, read } = overlay(sha.catalog);
    expect(output).toContain(`Catalog overlaid from ${sha.catalog}`);
    expect(status).toBe(0);
    expect(read(`${CATALOG}/default.json`)).toBe('{"version":"1.1.0"}\n');
    expect(read(`${CATALOG}/withdrawn.json`)).toBeNull();
    // Only the catalog moves: the rest is the site as released.
    expect(read("site.txt")).toBe("released site\n");
  });

  it("overlays master's tip itself", () => {
    const { status, read } = overlay(sha.unrelated);
    expect(status).toBe(0);
    expect(read(`${CATALOG}/default.json`)).toBe('{"version":"1.1.0"}\n');
  });

  it("refuses a commit whose catalog master has since moved past — a re-run of an older publish", () => {
    const { status, output, read } = overlay(sha.tag);
    expect(output).toContain(`::error::master's ${CATALOG} has changed since ${sha.tag}`);
    expect(output).toContain(`master is at ${sha.unrelated}`);
    expect(status).toBe(1);
    expect(read(`${CATALOG}/default.json`)).toBe('{"version":"1.0.0"}\n');
    expect(read(`${CATALOG}/withdrawn.json`)).toBe('{"version":"1.0.0"}\n');
  });

  it("refuses a commit carrying a catalog master does not hold", () => {
    const { status, output, read } = overlay(sha.stale);
    expect(output).toContain(`::error::master's ${CATALOG} has changed since ${sha.stale}`);
    expect(status).toBe(1);
    expect(read(`${CATALOG}/default.json`)).toBe('{"version":"1.0.0"}\n');
  });

  it("refuses a commit with no catalog at all", () => {
    const { status, output } = overlay(sha.noCatalog);
    expect(output).toContain(`::error::${sha.noCatalog} has no ${CATALOG}`);
    expect(status).toBe(1);
  });

  it("refuses a checkout that cannot build a catalog, before fetching anything", () => {
    const { status, output } = overlay(sha.catalog, { dropGenerator: true });
    expect(output).toContain("has no voice-catalog generator");
    expect(status).toBe(1);
  });
});
