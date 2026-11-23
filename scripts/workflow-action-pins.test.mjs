/**
 * Every third-party action is pinned to a full commit hash, with its release
 * in a trailing comment (#1663).
 *
 * A tag such as `@v6` is a pointer its owner can move: whoever controls the
 * repository (or steals a token for it) can repoint a release tag at new code,
 * and every workflow naming it runs that code on its next trigger, with this
 * repository's secrets and `GITHUB_TOKEN`. A full 40-hex commit hash cannot be
 * moved. So every `uses:` whose owner is not GitHub's own `actions` org
 * (compared case-insensitively) must name `@<40 lowercase hex>` and carry a
 * same-line `# v<major>(.<minor>…)` comment naming the release, which is how a
 * reader sees the version and how Dependabot's github-actions updates rewrite
 * the hash and the comment together. First-party `actions/*` stay on tags;
 * local `./…` actions and reusable workflows are this repository's own code.
 *
 * Decisions, each tested below:
 * - **Exactly 40 lowercase hex.** GitHub's commit ids are SHA-1, and Dependabot
 *   writes them lowercase; an uppercase or short hash is refused, since a short
 *   one is ambiguous and GitHub resolves neither as a commit pin.
 * - **The comment is the release tag and nothing else**: `# v6.1.1`, `# v0.11.0`,
 *   `# v3`. Dependabot rewrites a version comment only when it ends with the
 *   old release (`comment.rstrip.end_with?(version)` in dependabot-core's
 *   github_actions version commenter), so `# v6.1.1 (pnpm)` would get its hash
 *   bumped and its comment left naming the old release; the regex is anchored
 *   at both ends, which also refuses text before the tag, so a reader never has
 *   to work out which word is the version. It must be on the `uses:` line
 *   itself, so the test reads that line from the source (the scalar's `range`) rather than trusting where the
 *   parser attaches a comment: `yaml` 2.9.1 puts a same-line comment on the
 *   scalar's `comment`, but a comment on the following line can land on the
 *   step or the next key instead, and only the line is unambiguous.
 * - **`docker://` is refused outright.** A Docker image is third-party code too,
 *   and a `@sha256:` digest would pin it, but Dependabot's github-actions
 *   updates do not keep a digest current and nothing names its version, so it
 *   would rot unseen. Nothing here uses one; adding one means changing this
 *   test, with the reason.
 * - Both levels are read: step `uses` (`jobs.*.steps[*]`, a composite action's
 *   `runs.steps[*]`) and job `uses` (a reusable workflow, where
 *   `owner/repo/.github/workflows/x.yml@ref` is third-party and
 *   `./.github/workflows/x.yml` is local). A local step action is followed to
 *   its `action.yml`, so one kept outside `.github/actions/` is read too; a
 *   dangling one is `workflow-setup-node.test.mjs`'s to report.
 *
 * It is proven by positive controls (planted documents that must each be
 * reported) and by coverage floors, so a discovery or parser change that finds
 * nothing cannot stay green.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const REPO = path.join(import.meta.dirname, "..");
const GITHUB = path.join(REPO, ".github");
/** The real tree on 2026-11-23: 7× pnpm/action-setup, one Firebase deploy, one release upload. */
const MIN_THIRD_PARTY_USES = 9;
/** The real tree on 2026-11-23: ten workflows, no composite actions. */
const MIN_FILES = 10;

const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_COMMENT = /^#\s*v\d+(?:\.\d+)*\s*$/;

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

/** The value node under `key` in a YAML map node, or undefined. */
function child(node, key) {
  return isMap(node) ? node.get(key, true) : undefined;
}

/** Every `{ where, node, local }` `uses:` value node of a parsed document. */
function usesNodes(doc) {
  const out = [];
  const fromSteps = (steps, prefix) => {
    if (!isSeq(steps)) return;
    steps.items.forEach((step, i) => {
      const node = child(step, "uses");
      if (node === undefined) return;
      const name = child(step, "name");
      const named = isScalar(name) && typeof name.value === "string" ? ` (${JSON.stringify(name.value)})` : "";
      out.push({ where: `${prefix} step ${i + 1}${named}`, node, level: "step" });
    });
  };
  const jobs = child(doc.contents, "jobs");
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const jobId = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const job = pair.value;
      const node = child(job, "uses");
      if (node !== undefined) out.push({ where: `job "${jobId}"`, node, level: "job" });
      fromSteps(child(job, "steps"), `job "${jobId}"`);
    }
  }
  fromSteps(child(child(doc.contents, "runs"), "steps"), "composite");
  return out;
}

/** The text after a scalar on its own source line: where its trailing comment is. */
function restOfLine(source, node) {
  const end = node.range?.[1];
  if (typeof end !== "number") return "";
  const nl = source.indexOf("\n", end);
  return source.slice(end, nl === -1 ? source.length : nl).replace(/\r$/, "");
}

/** Whether a `uses:` value names this repository's own code. */
function isLocal(uses) {
  return uses.startsWith("./");
}

/** Whether a non-local `uses:` value names GitHub's first-party `actions` org. */
function isFirstParty(uses) {
  return uses.split("/")[0].toLowerCase() === "actions";
}

/**
 * Checks one parsed document's `uses:` values.
 *
 * @returns {{ violations: string[], thirdParty: number, localSteps: string[] }}
 *   `localSteps` are the step-level `./…` values, for the caller to follow.
 */
function pinViolations(fileName, source) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const violations = [];
  let thirdParty = 0;
  const localSteps = [];
  for (const error of doc.errors) violations.push(`${fileName}: does not parse as YAML: ${error.message}`);
  for (const { where, node, level } of usesNodes(doc)) {
    const line = node.range ? lineCounter.linePos(node.range[0]).line : "?";
    const label = `${fileName}:${line}: ${where}`;
    if (!isScalar(node) || typeof node.value !== "string") {
      violations.push(`${label} has a uses: that is not a string`);
      continue;
    }
    const uses = node.value;
    if (isLocal(uses)) {
      if (level === "step") localSteps.push(uses);
      continue;
    }
    if (uses.toLowerCase().startsWith("docker://")) {
      thirdParty++;
      violations.push(
        `${label} uses ${uses}: a docker:// image is not allowed, since nothing keeps its digest current or names its version`,
      );
      continue;
    }
    if (isFirstParty(uses)) continue;
    thirdParty++;
    const at = uses.indexOf("@");
    if (at === -1) {
      violations.push(`${label} uses ${uses} with no @ref; pin it to a full commit hash with a # v<release> comment`);
      continue;
    }
    const ref = uses.slice(at + 1);
    if (!FULL_SHA.test(ref)) {
      violations.push(
        `${label} uses ${uses}: ${JSON.stringify(ref)} is not a full 40-character lowercase commit hash; pin the commit, not a tag or branch`,
      );
      continue;
    }
    const rest = restOfLine(source, node).trim();
    if (!RELEASE_COMMENT.test(rest)) {
      violations.push(
        `${label} uses ${uses} without a same-line release comment like "# v1.2.3" (found ${JSON.stringify(rest)})`,
      );
    }
  }
  return { violations, thirdParty, localSteps };
}

/**
 * Walks `seeds` and every local step action they name, each file once.
 * `read(relPath)` returns the file's text, or undefined when there is none.
 */
function scan(seeds, read) {
  const violations = [];
  const visited = new Set();
  let thirdParty = 0;
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    const text = read(file);
    if (text === undefined) continue;
    visited.add(file);
    const r = pinViolations(file, text);
    violations.push(...r.violations);
    thirdParty += r.thirdParty;
    for (const uses of r.localSteps) {
      const dir = path.posix.normalize(uses);
      if (dir.startsWith("..")) continue;
      const target = [`${dir}/action.yml`, `${dir}/action.yaml`].find((f) => read(f) !== undefined);
      if (target !== undefined) queue.push(target);
    }
  }
  return { violations, thirdParty, visited };
}

/** Reads a repo-relative file from disk, or undefined when it is not a file. */
function readRepoFile(rel) {
  const full = path.join(REPO, rel);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
}

describe("every third-party action in .github is pinned to a commit hash", () => {
  const files = discoverFiles();
  const result = scan(files, readRepoFile);

  it("finds at least the known number of workflow and action files", () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);
    expect(result.visited.size).toBeGreaterThanOrEqual(MIN_FILES);
  });

  it("reads at least the known number of third-party uses", () => {
    expect(result.thirdParty).toBeGreaterThanOrEqual(MIN_THIRD_PARTY_USES);
  });

  it("has no unpinned third-party action", () => {
    expect(result.violations).toEqual([]);
  });
});

const SHA = "73e46992e05b19abd31f2f3c20e0e7370d762115";
const step = (line) => `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v7\n      - uses: ${line}\n`;
const check = (source, name = "w.yml") => pinViolations(name, source);

describe("pinViolations (positive controls)", () => {
  it("reports a tag-pinned third-party step, naming file, line, step and value", () => {
    const r = check(step("pnpm/action-setup@v6 # v6.1.1"));
    expect(r.thirdParty).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/^w\.yml:5: job "build" step 2 uses pnpm\/action-setup@v6: "v6" is not a full/);
  });

  it("reports a branch ref", () => {
    expect(check(step("owner/tool@main")).violations[0]).toMatch(/owner\/tool@main: "main" is not a full/);
  });

  it("reports a short hash", () => {
    expect(check(step("owner/tool@73e4699 # v1")).violations[0]).toMatch(/"73e4699" is not a full 40-character/);
  });

  it("reports an uppercase hash", () => {
    const upper = SHA.toUpperCase();
    expect(check(step(`owner/tool@${upper} # v1`)).violations[0]).toMatch(/is not a full 40-character lowercase/);
  });

  it("reports a 64-character hash", () => {
    expect(check(step(`owner/tool@${SHA}${SHA.slice(0, 24)} # v1`)).violations).toHaveLength(1);
  });

  it("reports a third-party uses with no @ref", () => {
    expect(check(step("owner/tool")).violations[0]).toMatch(/uses owner\/tool with no @ref/);
  });

  it("reports a pinned step with no comment", () => {
    const v = check(step(`owner/tool@${SHA}`)).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/w\.yml:5: job "build" step 2 uses owner\/tool@[0-9a-f]{40} without a same-line release/);
  });

  it("reports a comment that names no version", () => {
    expect(check(step(`owner/tool@${SHA} # pinned`)).violations[0]).toMatch(/found "# pinned"/);
  });

  it("reports text after the version, which Dependabot would leave stale", () => {
    for (const comment of ["# v6.1.1 (pnpm)", "# pnpm v6.1.1 latest", "# v1.2.3 latest"]) {
      const v = check(step(`owner/tool@${SHA} ${comment}`)).violations;
      expect(v, comment).toHaveLength(1);
      expect(v[0], comment).toContain(`found ${JSON.stringify(comment)}`);
    }
  });

  it("reports text before the version", () => {
    expect(check(step(`owner/tool@${SHA} # pnpm v6.1.1`)).violations).toHaveLength(1);
  });

  it("reports a version comment on the next line instead of the uses line", () => {
    const doc = `jobs:\n  build:\n    steps:\n      - uses: owner/tool@${SHA}\n        # v1.2.3\n        with:\n          a: 1\n`;
    expect(check(doc).violations[0]).toMatch(/without a same-line release comment/);
  });

  it("reports a job-level third-party reusable workflow on a tag", () => {
    const doc = "jobs:\n  call:\n    uses: owner/repo/.github/workflows/build.yml@v2\n";
    const r = check(doc);
    expect(r.thirdParty).toBe(1);
    expect(r.violations[0]).toMatch(/^w\.yml:3: job "call" uses owner\/repo\/\.github\/workflows\/build\.yml@v2: "v2"/);
  });

  it("reports a composite action step on a tag", () => {
    const doc = "runs:\n  using: composite\n  steps:\n    - name: Setup\n      uses: owner/tool@v3\n";
    expect(check(doc, "a/action.yml").violations[0]).toMatch(
      /^a\/action\.yml:5: composite step 1 \("Setup"\) uses owner\/tool@v3/,
    );
  });

  it("refuses a docker:// image, by tag or by digest", () => {
    expect(check(step("docker://alpine:3.20")).violations[0]).toMatch(/docker:\/\/alpine:3\.20: a docker:\/\/ image/);
    const digest = `docker://alpine@sha256:${"a".repeat(64)}`;
    expect(check(step(digest)).violations).toHaveLength(1);
  });

  it("reports a non-string uses and a document that does not parse", () => {
    expect(check(step("[a, b]")).violations[0]).toMatch(/is not a string/);
    expect(check("jobs:\n  a: [\n").violations[0]).toMatch(/does not parse as YAML/);
  });
});

describe("pinViolations (negative controls)", () => {
  it("accepts first-party actions on tags, in any case", () => {
    const doc = "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v7\n      - uses: Actions/Checkout@v4\n";
    const r = check(doc);
    expect(r).toEqual({ violations: [], thirdParty: 0, localSteps: [] });
  });

  it("accepts local actions and local reusable workflows, and hands the step ones back", () => {
    const doc = "jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n  b:\n    steps:\n      - uses: ./x\n";
    expect(check(doc)).toEqual({ violations: [], thirdParty: 0, localSteps: ["./x"] });
  });

  it("accepts a correctly pinned third-party step, job and quoted value", () => {
    const doc = [
      "jobs:",
      "  call:",
      `    uses: owner/repo/.github/workflows/build.yml@${SHA} # v2.0.1`,
      "  b:",
      "    steps:",
      `      - uses: pnpm/action-setup@${SHA} # v6.1.1`,
      "        with:",
      "          run_install: false",
      `      - uses: "owner/tool@${SHA}"   #v0.11.0`,
      `      - uses: owner/tool/sub@${SHA} # v3`,
      "",
    ].join("\r\n");
    const r = check(doc);
    expect(r.violations).toEqual([]);
    expect(r.thirdParty).toBe(4);
  });
});

describe("scan (local actions, in-memory tree)", () => {
  const tree = (files) => (rel) => files[rel];

  it("follows a local step action and reports its tag-pinned step", () => {
    const r = scan(
      ["w.yml"],
      tree({
        "w.yml": step("./ci/setup"),
        "ci/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: owner/tool@v1\n",
      }),
    );
    expect([...r.visited].sort()).toEqual(["ci/setup/action.yml", "w.yml"]);
    expect(r.thirdParty).toBe(1);
    expect(r.violations[0]).toMatch(/^ci\/setup\/action\.yml:4: composite step 1 uses owner\/tool@v1/);
  });

  it("skips a dangling local action and survives a cycle", () => {
    const self = "runs:\n  using: composite\n  steps:\n    - uses: ./a\n    - uses: ./missing\n";
    const r = scan(["w.yml"], tree({ "w.yml": step("./a"), "a/action.yml": self }));
    expect(r.violations).toEqual([]);
    expect([...r.visited].sort()).toEqual(["a/action.yml", "w.yml"]);
  });
});
