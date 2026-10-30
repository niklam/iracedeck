/**
 * Every `actions/setup-node` step reads `.nvmrc` (#1503).
 *
 * `.nvmrc` pins one exact Node (24.21.0, #1444) because 24.15.0 crashes test
 * workers on Windows. A workflow that sets `node-version: 24` resolves to
 * whatever 24.x the runner carries that day, so the shipped bundle and the
 * voice-pack archives were once built on a Node nobody chose (#1513). Nothing
 * else notices that drift, so this test does: every setup-node step in
 * `.github/workflows/` and in any composite action must set
 * `node-version-file: '.nvmrc'` and no `node-version`.
 *
 * It is proven by positive controls (a literal version, a missing `with`, and
 * another version file must each be reported) and by a coverage floor, so a
 * parser or discovery change that finds no steps cannot stay green.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = path.join(import.meta.dirname, "..");
const GITHUB = path.join(REPO, ".github");
const MIN_SETUP_NODE_STEPS = 7;

/** Workflow files plus composite-action files, as repo-relative names. */
function discoverFiles() {
  const files = [];
  const workflows = path.join(GITHUB, "workflows");
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows)) {
      if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
    }
  }
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const r = `${rel}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, r);
      else if (/^action\.ya?ml$/.test(entry)) files.push(r);
    }
  };
  const actions = path.join(GITHUB, "actions");
  if (existsSync(actions)) walk(actions, ".github/actions");
  return files;
}

/** Every `{ where, step }` in a parsed workflow or composite action. */
function stepsOf(doc) {
  const out = [];
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    (job?.steps ?? []).forEach((step, i) => out.push({ where: `job "${jobId}" step ${i + 1}`, step }));
  }
  (doc?.runs?.steps ?? []).forEach((step, i) => out.push({ where: `composite step ${i + 1}`, step }));
  return out;
}

/** @returns {{ where: string, step: any }[]} the setup-node steps of a parsed document. */
function setupNodeSteps(doc) {
  return stepsOf(doc).filter(
    ({ step }) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@"),
  );
}

/** Violations, as readable strings, for one parsed workflow or action. */
function setupNodeViolations(fileName, doc) {
  const violations = [];
  for (const { where, step } of setupNodeSteps(doc)) {
    const w = step.with;
    const label = `${fileName}: ${where}`;
    if (!w || typeof w !== "object") {
      violations.push(
        `${label} has no \`with\`, so it uses the runner's default Node; set node-version-file: '.nvmrc'`,
      );
      continue;
    }
    if (w["node-version"] !== undefined) {
      violations.push(`${label} sets node-version (${String(w["node-version"])}); read .nvmrc instead`);
    }
    if (w["node-version-file"] !== ".nvmrc") {
      violations.push(`${label} has node-version-file ${JSON.stringify(w["node-version-file"])}; it must be ".nvmrc"`);
    }
  }
  return violations;
}

describe(".nvmrc is the one Node pin", () => {
  it("holds one exact x.y.z version", () => {
    expect(readFileSync(path.join(REPO, ".nvmrc"), "utf8").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * Walks `seeds` (repo-relative files) and every local action a step names with
 * `uses: ./<dir>`, recursively, each file once. `read(relPath)` returns the
 * file's text, or undefined when there is none, so a test can hand in an
 * in-memory tree. A job-level `uses: ./.github/workflows/x.yml` is a reusable
 * workflow, which discovery already scans, so only step-level `uses` is followed.
 */
function scan(seeds, read) {
  const violations = [];
  const visited = new Set();
  let setupNodeCount = 0;
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = read(file);
    if (text === undefined) continue;
    const doc = parse(text);
    setupNodeCount += setupNodeSteps(doc).length;
    violations.push(...setupNodeViolations(file, doc));
    for (const { where, step } of stepsOf(doc)) {
      if (typeof step?.uses !== "string" || !step.uses.startsWith("./")) continue;
      const dir = path.posix.normalize(step.uses);
      const target = [`${dir}/action.yml`, `${dir}/action.yaml`].find((f) => read(f) !== undefined);
      if (dir.startsWith("..") || target === undefined) {
        violations.push(
          `${file}: ${where} uses ${step.uses}, which is not a directory with an action.yml or action.yaml`,
        );
      } else {
        queue.push(target);
      }
    }
  }
  return { violations, setupNodeCount, visited };
}

/** Reads a repo-relative file from disk, or undefined when it is not a file. */
function readRepoFile(rel) {
  const full = path.join(REPO, rel);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
}

describe("every actions/setup-node step reads .nvmrc", () => {
  const files = discoverFiles();
  const result = scan(files, readRepoFile);

  it("finds the workflows", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("walks at least the known number of setup-node steps", () => {
    expect(result.setupNodeCount).toBeGreaterThanOrEqual(MIN_SETUP_NODE_STEPS);
  });

  it("has no violation in .github or in a local action it uses", () => {
    expect(result.violations).toEqual([]);
  });
});

describe("scan (local actions, in-memory tree)", () => {
  const tree = (files) => (rel) => files[rel];
  const caller = (uses) => `jobs:\n  build:\n    steps:\n      - uses: ${uses}\n`;
  const setup = (withBlock) => `runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n${withBlock}`;

  it("follows uses: ./ci/setup and reports its literal node-version", () => {
    const r = scan(
      ["w.yml"],
      tree({ "w.yml": caller("./ci/setup"), "ci/setup/action.yml": setup("      with:\n        node-version: 24\n") }),
    );
    expect(r.setupNodeCount).toBe(1);
    expect(r.violations.join("\n")).toMatch(/ci\/setup\/action\.yml: composite step 1 sets node-version \(24\)/);
  });

  it("finds an action.yaml and passes a compliant one", () => {
    const r = scan(
      ["w.yml"],
      tree({
        "w.yml": caller("./ci/setup"),
        "ci/setup/action.yaml": setup("      with:\n        node-version-file: .nvmrc\n"),
      }),
    );
    expect(r.setupNodeCount).toBe(1);
    expect(r.violations).toEqual([]);
  });

  it("reports a dangling ./missing, naming the file and step", () => {
    const r = scan(["w.yml"], tree({ "w.yml": caller("./missing") }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/w\.yml: job "build" step 1 uses \.\/missing, which is not a directory/);
  });

  it("does not treat a job-level reusable workflow as a missing action", () => {
    const doc = "jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n";
    expect(scan(["w.yml"], tree({ "w.yml": doc })).violations).toEqual([]);
  });

  it("visits a shared local action once and survives a cycle", () => {
    const self = "runs:\n  using: composite\n  steps:\n    - uses: ./a\n";
    const r = scan(["w.yml"], tree({ "w.yml": caller("./a"), "a/action.yml": self }));
    expect(r.violations).toEqual([]);
    expect([...r.visited].sort()).toEqual(["a/action.yml", "w.yml"]);
  });
});

describe("setupNodeViolations (positive controls)", () => {
  const wf = (withBlock) => `
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
${withBlock}
`;

  it("reports a literal node-version", () => {
    const v = setupNodeViolations("x.yml", parse(wf("        with:\n          node-version: 24")));
    expect(v.join("\n")).toMatch(/x\.yml: job "build" step 2 sets node-version \(24\)/);
  });

  it("reports a setup-node step with no with", () => {
    const v = setupNodeViolations("y.yml", parse(wf("")));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/y\.yml: job "build" step 2 has no `with`/);
  });

  it("reports another version file", () => {
    const v = setupNodeViolations("z.yml", parse(wf("        with:\n          node-version-file: package.json")));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/z\.yml: job "build" step 2 .*"package\.json"/);
  });

  it("accepts node-version-file .nvmrc and ignores other steps", () => {
    expect(setupNodeViolations("ok.yml", parse(wf("        with:\n          node-version-file: '.nvmrc'")))).toEqual(
      [],
    );
  });

  it("walks a composite action's steps", () => {
    const doc = parse(
      "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n      with:\n        node-version: 20\n",
    );
    expect(setupNodeViolations("a/action.yml", doc)[0]).toMatch(/a\/action\.yml: composite step 1 sets node-version/);
  });
});
