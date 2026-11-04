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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BASH, createStepSandbox, readWorkflow, stepNamed, writeFile } from "./lib/workflow-step-runner.mjs";

const PUBLISH_WORKFLOW = ".github/workflows/publish-voice-packs.yml";
const HOSTING_WORKFLOW = ".github/workflows/firebase-hosting-release.yml";
const GUARD_STEP = "Refuse to publish from a ref other than master";
const OVERLAY_STEP = "Overlay the voice-pack catalog from another ref";
const CATALOG = "packages/audio-assets/catalog";

it("finds a bash to run the workflow steps with", () => {
  expect(BASH, "no bash found (on Windows: Git for Windows' bin/bash.exe beside git)").toBeDefined();
});

let box;

beforeAll(() => {
  box = createStepSandbox("ird-voice-publish-");
});

afterAll(() => box?.remove());

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
  const guard = (ref) => box.runStep(step.run, box.work, { DISPATCHED_REF: ref });

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

  it("deploys one overlay at a time, never cancels one in flight, and keeps releases in a group of their own", () => {
    // Per kind of caller: GitHub cancels a pending run when a third arrives, and a
    // release must not evict a pending publish whose archive is already up.
    expect(readWorkflow(HOSTING_WORKFLOW).jobs.build_and_deploy.concurrency).toEqual({
      group: "firebase-hosting-live-${{ inputs.catalog_ref && 'catalog-overlay' || 'release' }}",
      "cancel-in-progress": false,
    });
  });
});

describe.skipIf(BASH === undefined)("the overlay step, run against a fetched origin", () => {
  const { step } = stepNamed(readWorkflow(HOSTING_WORKFLOW), "build_and_deploy", OVERLAY_STEP);
  let origin;
  const sha = {};

  const git = (cwd, ...args) => box.git(cwd, ...args);
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
    origin = path.join(box.work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "master");
    // GitHub serves any reachable commit by sha; a local upload-pack does not by default.
    git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");

    writeFile(origin, "scripts/lib/voice-catalog-data.mjs", "export {};\n");
    writeFile(origin, `${CATALOG}/default.json`, '{"version":"1.0.0"}\n');
    writeFile(origin, `${CATALOG}/withdrawn.json`, '{"version":"1.0.0"}\n');
    writeFile(origin, "site.txt", "released site\n");
    sha.tag = commit("the stable release");
    git(origin, "tag", "v1.0.0");

    writeFile(origin, `${CATALOG}/default.json`, '{"version":"1.1.0"}\n');
    rmSync(path.join(origin, CATALOG, "withdrawn.json"));
    sha.catalog = commit("bump default, withdraw a pack");

    writeFile(origin, "site.txt", "unreleased docs\n");
    sha.unrelated = commit("unrelated master work");

    git(origin, "checkout", "-q", "-b", "stale", sha.catalog);
    writeFile(origin, `${CATALOG}/default.json`, '{"version":"1.2.0"}\n');
    sha.stale = commit("an entry master never took");

    git(origin, "checkout", "-q", "-b", "no-catalog", sha.unrelated);
    rmSync(path.join(origin, CATALOG), { recursive: true });
    sha.noCatalog = commit("no catalog");

    git(origin, "checkout", "-q", "master");
  });

  /** A shallow checkout of the stable tag, as actions/checkout leaves it, with the step run in it. */
  function overlay(catalogRef, { dropGenerator = false } = {}) {
    const checkout = path.join(box.work, `checkout-${Math.random().toString(36).slice(2)}`);
    git(box.work, "clone", "-q", "--depth=1", "--branch", "v1.0.0", pathToFileURL(origin).href, checkout);
    if (dropGenerator) rmSync(path.join(checkout, "scripts/lib/voice-catalog-data.mjs"));
    const run = box.runStep(step.run, checkout, { CATALOG_REF: catalogRef });
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
