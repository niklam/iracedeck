/**
 * A deploy refuses a voice-pack catalog behind master's (#1613).
 *
 * A tag release deploys the site and `packages/audio-assets/catalog/` from the
 * tag. A patch tagged from a release branch cut before a voice-pack bump on
 * master would put the older entry live over the newer one a between-releases
 * publish already deployed, and nothing would go red: the older archive is
 * still published. `firebase-hosting-release.yml`'s deploying job therefore
 * compares the checkout's catalog with master's before it installs anything,
 * and refuses when any pack master has is missing here or at a lower version.
 *
 * The step's place in the job is asserted over the parsed YAML, each assertion
 * positive-controlled against a mutated copy, since an assertion that cannot
 * fail proves nothing. The step itself is run for real, extracted from the YAML,
 * in a shallow tag checkout of a throwaway `origin`, as on GitHub.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BASH, createStepSandbox, readWorkflow, stepNamed, writeFile } from "./lib/workflow-step-runner.mjs";

const HOSTING_WORKFLOW = ".github/workflows/firebase-hosting-release.yml";
const JOB = "build_and_deploy";
const CHECK_STEP = "Refuse a voice-pack catalog behind master's";
const OVERLAY_STEP = "Overlay the voice-pack catalog from another ref";
const CATALOG = "packages/audio-assets/catalog";

it("finds a bash to run the workflow step with", () => {
  expect(BASH, "no bash found (on Windows: Git for Windows' bin/bash.exe beside git)").toBeDefined();
});

/** Index of the first step of `job` matching `predicate`, or a failure naming `what`. */
function indexOf(doc, what, predicate) {
  const index = (doc?.jobs?.[JOB]?.steps ?? []).findIndex((s) => s && predicate(s));
  if (index === -1) throw new Error(`job "${JOB}" has no ${what} step`);
  return index;
}

const installIndex = (doc) => indexOf(doc, "pnpm install", (s) => s.run?.trim() === "pnpm install");
const deployIndex = (doc) =>
  indexOf(doc, "Firebase deploy", (s) => s.uses?.startsWith("FirebaseExtended/action-hosting-deploy") ?? false);

/** Each throws when the workflow no longer holds what it names. */
const ASSERTIONS = {
  "is a step of the deploying job": (doc) => {
    stepNamed(doc, JOB, CHECK_STEP);
  },
  "runs after the overlay and before both the install and the deploy": (doc) => {
    const { index } = stepNamed(doc, JOB, CHECK_STEP);
    expect(index).toBeGreaterThan(stepNamed(doc, JOB, OVERLAY_STEP).index);
    expect(index).toBeLessThan(installIndex(doc));
    expect(index).toBeLessThan(deployIndex(doc));
  },
  "runs on every deploy, with no condition": (doc) => {
    expect(stepNamed(doc, JOB, CHECK_STEP).step).not.toHaveProperty("if");
  },
  "fails the job when it fails": (doc) => {
    expect(stepNamed(doc, JOB, CHECK_STEP).step).not.toHaveProperty("continue-on-error");
    expect(doc.jobs[JOB]).not.toHaveProperty("continue-on-error");
  },
  "interpolates no expression into its script": (doc) => {
    expect(stepNamed(doc, JOB, CHECK_STEP).step.run).not.toContain("${{");
  },
};

/** Moves the check step to just after the step at `targetIndex(doc)`. */
function moveAfter(doc, targetIndex) {
  const steps = doc.jobs[JOB].steps;
  const [step] = steps.splice(stepNamed(doc, JOB, CHECK_STEP).index, 1);
  steps.splice(targetIndex(doc) + 1, 0, step);
}

/** [mutation, the assertion it must break, how to apply it to a copy of the doc]. */
const MUTATIONS = [
  [
    "the step removed",
    "is a step of the deploying job",
    (doc) => doc.jobs[JOB].steps.splice(stepNamed(doc, JOB, CHECK_STEP).index, 1),
  ],
  [
    "the step moved after the deploy",
    "runs after the overlay and before both the install and the deploy",
    (doc) => moveAfter(doc, deployIndex),
  ],
  [
    "the step moved after the install",
    "runs after the overlay and before both the install and the deploy",
    (doc) => moveAfter(doc, installIndex),
  ],
  [
    "the step moved before the overlay",
    "runs after the overlay and before both the install and the deploy",
    (doc) => moveAfter(doc, () => 0),
  ],
  [
    "an if added",
    "runs on every deploy, with no condition",
    (doc) => (stepNamed(doc, JOB, CHECK_STEP).step.if = "inputs.version"),
  ],
  [
    "continue-on-error on the step",
    "fails the job when it fails",
    (doc) => (stepNamed(doc, JOB, CHECK_STEP).step["continue-on-error"] = true),
  ],
  ["continue-on-error on the job", "fails the job when it fails", (doc) => (doc.jobs[JOB]["continue-on-error"] = true)],
  [
    "an expression in the script",
    "interpolates no expression into its script",
    (doc) => (stepNamed(doc, JOB, CHECK_STEP).step.run += 'echo "${{ inputs.version }}"\n'),
  ],
];

describe(`${HOSTING_WORKFLOW}'s catalog check step (#1613)`, () => {
  const doc = readWorkflow(HOSTING_WORKFLOW);

  it.each(Object.entries(ASSERTIONS))("%s", (_name, assertion) => {
    assertion(doc);
  });

  it.each(MUTATIONS)("an assertion catches %s", (_mutation, assertionName, mutate) => {
    const mutated = structuredClone(doc);
    mutate(mutated);
    expect(() => ASSERTIONS[assertionName](mutated)).toThrow();
  });

  it("pairs every assertion with a mutation that breaks it", () => {
    expect(new Set(MUTATIONS.map(([, name]) => name))).toEqual(new Set(Object.keys(ASSERTIONS)));
  });
});

let box;

beforeAll(() => {
  box = createStepSandbox("ird-voice-tag-catalog-");
});

afterAll(() => box?.remove());

describe.skipIf(BASH === undefined)("the catalog check step, run against a fetched origin", { timeout: 60_000 }, () => {
  const { step } = stepNamed(readWorkflow(HOSTING_WORKFLOW), JOB, CHECK_STEP);
  let cases = 0;

  /** An entry's file text: a version string becomes `{"version": …}`; `{ raw }` is written as is. */
  const entryText = (value) => (typeof value === "string" ? `${JSON.stringify({ version: value })}\n` : value.raw);

  function writeCatalog(root, catalog) {
    for (const [id, value] of Object.entries(catalog)) writeFile(root, `${CATALOG}/${id}.json`, entryText(value));
  }

  /**
   * origin's master:  v1.0.0 (the tag's catalog) ── master's catalog (tip)
   *
   * `master: null` leaves master with no catalog directory. The step runs in a
   * shallow clone of the tag, as actions/checkout leaves it. `origin` breaks
   * origin after the clone: "no-master" renames its master away, "gone" points
   * the checkout's origin at a repository that does not exist.
   */
  function check({ tag, master, extraMasterFiles = {}, origin: breakOrigin } = {}) {
    const root = path.join(box.work, `case-${++cases}`);
    const origin = path.join(root, "origin");
    mkdirSync(origin, { recursive: true });
    const git = (cwd, ...args) => box.git(cwd, ...args);
    git(origin, "init", "-q", "-b", "master");
    // As on GitHub, which serves any reachable commit; the step fetches by branch name.
    git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");

    writeFile(origin, "site.txt", "released site\n");
    writeCatalog(origin, tag);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "the release");
    git(origin, "tag", "v1.0.0");

    rmSync(path.join(origin, CATALOG), { recursive: true, force: true });
    if (master !== null) writeCatalog(origin, master);
    for (const [rel, text] of Object.entries(extraMasterFiles)) writeFile(origin, rel, text);
    writeFile(origin, "site.txt", "unreleased docs\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "master moves on");
    const masterSha = git(origin, "rev-parse", "HEAD");

    const checkout = path.join(root, "checkout");
    git(root, "clone", "-q", "--depth=1", "--branch", "v1.0.0", pathToFileURL(origin).href, checkout);
    if (breakOrigin === "no-master") git(origin, "branch", "-q", "-m", "master", "main");
    if (breakOrigin === "gone")
      git(checkout, "remote", "set-url", "origin", pathToFileURL(path.join(root, "gone")).href);

    const { status, output } = box.runStep(step.run, checkout);
    const lines = output.split(/\r?\n/);
    return { status, output, lines, masterSha };
  }

  /** The one line naming pack `id`'s problem, asserted to be its error annotation. */
  function errorFor({ lines, output }, id) {
    const named = lines.filter((line) => line.includes(`"${id}"`));
    expect(named, `exactly one line names "${id}" in:\n${output}`).toHaveLength(1);
    expect(named[0].startsWith(`::error file=${CATALOG}/${id}.json::`), named[0]).toBe(true);
    return named[0];
  }

  /** The one line containing `text`, asserted to be an error annotation. */
  function errorLine({ lines, output }, text) {
    const found = lines.filter((line) => line.includes(text));
    expect(found, `exactly one line contains ${JSON.stringify(text)} in:\n${output}`).toHaveLength(1);
    expect(found[0].startsWith("::error::"), found[0]).toBe(true);
    return found[0];
  }

  const okLine = ({ lines }, id) => lines.find((line) => line.startsWith(`ok  ${id}  `));

  it("refuses a tag whose pack is behind master's, naming the pack, both versions, master and the remedy", () => {
    const run = check({ tag: { default: "1.3.0" }, master: { default: "1.4.0" } });
    const line = errorFor(run, "default");
    expect(line).toContain("is at 1.3.0 in v1.0.0 but at 1.4.0 on master");
    expect(line).toContain(run.masterSha);
    expect(line).toContain("cherry-pick master's catalog bump commits");
    errorLine(run, "1 voice-pack catalog entry in v1.0.0 cannot be deployed");
    expect(run.status).toBe(1);
  });

  it("passes a tag at master's version, ignoring master's non-JSON files", () => {
    const run = check({
      tag: { default: "1.4.0" },
      master: { default: "1.4.0" },
      extraMasterFiles: { [`${CATALOG}/README.md`]: "not an entry\n" },
    });
    expect(okLine(run, "default")).toBe("ok  default  1.4.0 >= 1.4.0");
    expect(run.output).toContain(`Every voice pack in master's catalog (${run.masterSha}) is here`);
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });

  it("passes a tag ahead of master", () => {
    const run = check({ tag: { default: "1.5.0" }, master: { default: "1.4.0" } });
    expect(okLine(run, "default")).toBe("ok  default  1.5.0 >= 1.4.0");
    expect(run.status).toBe(0);
  });

  it("passes a pack only the tag has", () => {
    const run = check({ tag: { default: "1.4.0", early: "1.0.0" }, master: { default: "1.4.0" } });
    expect(run.output).not.toContain("::error");
    expect(run.output).toContain("1 compared");
    expect(run.status).toBe(0);
  });

  it("refuses a pack only master has: deploying would remove it", () => {
    const run = check({ tag: { default: "1.4.0" }, master: { default: "1.4.0", fresh: "1.0.0" } });
    expect(errorFor(run, "fresh")).toContain("is missing in v1.0.0 but at 1.0.0 on master");
    expect(okLine(run, "default")).toBeDefined();
    expect(run.status).toBe(1);
  });

  it("refuses when the tag has no catalog at all and master has one", () => {
    const run = check({ tag: {}, master: { default: "1.4.0" } });
    expect(errorFor(run, "default")).toContain("is missing in v1.0.0");
    expect(run.status).toBe(1);
  });

  it("reports every problem, not only the first", () => {
    const run = check({
      tag: { alpha: "1.0.0", beta: "2.0.0", gamma: "3.0.0" },
      master: { alpha: "1.1.0", beta: "2.0.0", gamma: "3.0.1" },
    });
    expect(errorFor(run, "alpha")).toContain("is at 1.0.0 in v1.0.0 but at 1.1.0 on master");
    expect(errorFor(run, "gamma")).toContain("is at 3.0.0 in v1.0.0 but at 3.0.1 on master");
    expect(okLine(run, "beta")).toBe("ok  beta  2.0.0 >= 2.0.0");
    errorLine(run, "2 voice-pack catalog entries in v1.0.0 cannot be deployed");
    expect(run.status).toBe(1);
  });

  // [tag, master]: the tag is at or above master under semver precedence.
  const AT_OR_ABOVE = [
    ["1.2.0", "1.2.0-rc.1"],
    ["1.2.0-rc.2", "1.2.0-rc.1"],
    ["1.2.0-rc.10", "1.2.0-rc.2"],
    ["1.2.0-alpha.beta", "1.2.0-alpha.1"],
    ["1.2.0-alpha.1", "1.2.0-alpha"],
    ["1.2.0-beta", "1.2.0-alpha"],
    ["1.2.0-Beta", "1.2.0-BETA"],
    ["1.2.0-rc.1", "1.2.0-rc.1"],
    ["1.2.0+a", "1.2.0"],
    ["1.2.0", "1.2.0+zzz"],
    ["1.2.0-rc.1+b", "1.2.0-rc.1+a"],
    ["v1.2.0", "1.2.0"],
    ["1.2.0", "v1.2.0"],
    [" 1.2.0 ", "1.2.0"],
    ["1.10.0", "1.9.0"],
    ["2.0.0", "1.99.99"],
    ["1.2.99999999999999999999", "1.2.99999999999999999998"],
  ];

  // [tag, master]: the tag is behind master under semver precedence.
  const BEHIND = [
    ["1.2.0-rc.1", "1.2.0"],
    ["1.2.0-rc.2", "1.2.0-rc.10"],
    ["1.2.0-alpha.1", "1.2.0-alpha.beta"],
    ["1.2.0-alpha", "1.2.0-alpha.1"],
    ["1.2.0-alpha", "1.2.0-beta"],
    ["1.2.0-BETA", "1.2.0-Beta"],
    ["1.9.0", "1.10.0"],
    ["1.99.99", "2.0.0"],
    ["1.2.99999999999999999998", "1.2.99999999999999999999"],
    ["v1.1.0", "1.2.0"],
    ["1.1.0+zzz", "1.2.0"],
  ];

  const packsOf = (pairs, side) => Object.fromEntries(pairs.map((pair, i) => [`case-${i}`, pair[side]]));

  it("passes every version pair at or above master's", () => {
    const run = check({ tag: packsOf(AT_OR_ABOVE, 0), master: packsOf(AT_OR_ABOVE, 1) });
    AT_OR_ABOVE.forEach(([tag, master], i) => {
      expect(okLine(run, `case-${i}`), `${JSON.stringify(tag)} >= ${JSON.stringify(master)}`).toBe(
        `ok  case-${i}  ${tag} >= ${master}`,
      );
    });
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });

  it("refuses every version pair behind master's", () => {
    const run = check({ tag: packsOf(BEHIND, 0), master: packsOf(BEHIND, 1) });
    BEHIND.forEach(([tag, master], i) => {
      expect(errorFor(run, `case-${i}`)).toContain(`is at ${tag} in v1.0.0 but at ${master} on master`);
    });
    expect(run.lines.some((line) => line.startsWith("ok  "))).toBe(false);
    errorLine(run, `${BEHIND.length} voice-pack catalog entries in v1.0.0 cannot be deployed`);
    expect(run.status).toBe(1);
  });

  it.each([
    ["two-part", "1.2", 'version "1.2", which is not a semver version'],
    ["leading zero", "01.2.0", 'version "01.2.0", which is not a semver version'],
    ["leading-zero pre-release", "1.2.0-01", 'version "1.2.0-01", which is not a semver version'],
    ["capital V", "V1.2.0", 'version "V1.2.0", which is not a semver version'],
    ["word", "latest", 'version "latest", which is not a semver version'],
    ["number", { raw: '{"version": 1}\n' }, "version 1, which is not a semver version"],
    ["absent", { raw: '{"id": "default"}\n' }, 'no "version"'],
  ])("refuses an unparseable version on the tag (%s)", (_kind, version, shown) => {
    const run = check({ tag: { default: version }, master: { default: "1.2.0" } });
    const line = errorFor(run, "default");
    expect(line).toContain(`${CATALOG}/default.json in v1.0.0 has ${shown}, so pack "default" cannot be compared`);
    expect(line).toContain(`master's 1.2.0 (${run.masterSha})`);
    expect(run.status).toBe(1);
  });

  it.each([
    ["word", "latest", 'version "latest", which is not a semver version'],
    ["absent", { raw: "{}\n" }, 'no "version"'],
    ["array", { raw: "[]\n" }, 'no "version"'],
  ])("refuses an unparseable version on master (%s)", (_kind, version, shown) => {
    const run = check({ tag: { default: "1.2.0" }, master: { default: version } });
    const line = errorFor(run, "default");
    expect(line).toContain(`master's ${CATALOG}/default.json (at ${run.masterSha}) has ${shown}`);
    expect(run.status).toBe(1);
  });

  it("refuses an entry on master that is not JSON, and still checks the rest", () => {
    const run = check({
      tag: { default: "1.2.0", other: "1.0.0" },
      master: { default: { raw: "{not json\n" }, other: "1.1.0" },
    });
    expect(errorFor(run, "default")).toContain(
      `master's ${CATALOG}/default.json (at ${run.masterSha}) is not valid JSON`,
    );
    expect(errorFor(run, "other")).toContain("is at 1.0.0 in v1.0.0 but at 1.1.0 on master");
    expect(run.status).toBe(1);
  });

  it("refuses an entry on the tag that is not JSON", () => {
    const run = check({ tag: { default: { raw: "{not json\n" } }, master: { default: "1.2.0" } });
    expect(errorFor(run, "default")).toContain(`${CATALOG}/default.json in v1.0.0 is not valid JSON`);
    expect(run.status).toBe(1);
  });

  it("refuses when master has no catalog directory", () => {
    const run = check({ tag: { default: "1.2.0" }, master: null });
    errorLine(run, `master (${run.masterSha}) has no ${CATALOG} directory`);
    expect(run.status).toBe(1);
  });

  it("refuses when master's catalog path is a file, not a directory", () => {
    const run = check({ tag: { default: "1.2.0" }, master: null, extraMasterFiles: { [CATALOG]: "moved\n" } });
    errorLine(run, `master (${run.masterSha}) has no ${CATALOG} directory`);
    expect(run.status).toBe(1);
  });

  it.each([
    ["origin has no master branch", "no-master"],
    ["origin cannot be reached", "gone"],
  ])("refuses when master cannot be fetched (%s)", (_kind, breakOrigin) => {
    const run = check({ tag: { default: "1.2.0" }, master: { default: "1.2.0" }, origin: breakOrigin });
    errorLine(run, "master could not be fetched from origin");
    expect(run.status).toBe(1);
  });
});
