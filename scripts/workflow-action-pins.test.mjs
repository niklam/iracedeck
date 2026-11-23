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
 * same-line `# v<major>.<minor>[.<patch>]` comment naming the release, which is how a
 * reader sees the version and how Dependabot's github-actions updates rewrite
 * the hash and the comment together. First-party `actions/*` stay on tags;
 * local `./…` actions and reusable workflows are this repository's own code.
 *
 * Decisions, each tested below:
 * - **Exactly 40 lowercase hex.** GitHub's commit ids are SHA-1, and Dependabot
 *   writes them lowercase; an uppercase or short hash is refused, since a short
 *   one is ambiguous and GitHub resolves neither as a commit pin.
 * - **The comment is the release tag and nothing else, at least major.minor**:
 *   `# v6.1.1`, `# v0.11.0`, `# 1.4.0`, `# v2.0.0-rc.1`. Dependabot writes it as
 *   ` # <tag>` in the tag's own spelling, with or without the `v` and with any
 *   semver prerelease suffix, and rewrites it only when the comment ends with
 *   the most specific tag for the old hash (`comment.rstrip.end_with?(version)`
 *   in dependabot-core's github_actions version commenter). So
 *   `# v6.1.1 (pnpm)` would get its hash bumped and its comment left naming the
 *   old release, and so would a moving major, `# v6` on a v6.1.1 commit. The
 *   regex is anchored at both ends, which also refuses text before the tag, so
 *   a reader never has to work out which word is the version. An action that
 *   publishes only major tags is the one case where `# v3` is right, since `v3`
 *   is then its most specific tag; pinning one means widening this regex for
 *   it, with that reason, in the same change.
 * - **The comment is on the line where the value is written.** The test reads
 *   that line from the source (the scalar's `range`) rather than trusting where
 *   the parser attaches a comment: `yaml` 2.9.1 puts a same-line comment on the
 *   scalar's `comment`, but a comment on the following line can land on the
 *   step or the next key instead, and only the line is unambiguous. For a value
 *   reached through an alias, that is the anchored definition's line, which is
 *   where Dependabot edits it and where a violation points.
 * - **Nothing is skipped because it is spelled unusually.** Keys (`jobs`,
 *   `steps`, `runs`, `uses`, `name`) are matched case-insensitively, a key
 *   spelled twice is checked under both spellings, aliases (`- *setup`,
 *   `uses: *pin`, an aliased job or `steps`) are resolved, and a merge key
 *   (`<<: *base`) is followed, whether or not GitHub honours it: a guard that
 *   passes what it cannot read fails open. An alias with no anchor is
 *   reported, and an alias or merge cycle ends rather than loops.
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
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const REPO = path.join(import.meta.dirname, "..");
const GITHUB = path.join(REPO, ".github");
/** The real tree on 2026-11-23: 7× pnpm/action-setup, one Firebase deploy, one release upload. */
const MIN_THIRD_PARTY_USES = 9;
/** The real tree on 2026-11-23: ten workflows, no composite actions. */
const MIN_FILES = 10;

const FULL_SHA = /^[0-9a-f]{40}$/;
/** Applied to the trimmed rest of the line: `# [v]<major>.<minor>[.<patch>…][-<prerelease>]`, nothing else. */
const RELEASE_COMMENT = /^#\s*v?\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** More alias hops than any real document needs; past it the alias is reported as unresolved. */
const MAX_ALIAS_HOPS = 8;

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

/**
 * Every `{ where, node, level }` `uses:` value of a parsed document, with each
 * node already resolved through any alias, plus the aliases that resolve to
 * nothing (`problems`, as `<line>: <message>`).
 */
function usesNodes(doc, lineCounter) {
  const out = [];
  const problems = new Set();
  const lineOf = (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : "?");

  /** The node an alias names (the node itself when it is none), or undefined, reported, when it names nothing. */
  const resolve = (node) => {
    let n = node;
    for (let hops = 0; isAlias(n); hops++) {
      const target = hops < MAX_ALIAS_HOPS ? n.resolve(doc) : undefined;
      if (target === undefined) {
        problems.add(
          `${lineOf(node)}: alias *${node.source} does not resolve to a node, so what it names is unchecked`,
        );
        return undefined;
      }
      n = target;
    }
    return n;
  };

  /**
   * A map's `{ key, lower, value }` entries (`value` unresolved), merge keys
   * (`<<`) expanded in place; each map is expanded once per call, so a merge
   * cycle ends.
   */
  const entries = (node, seen = new Set()) => {
    const map = resolve(node);
    if (!isMap(map) || seen.has(map)) return [];
    seen.add(map);
    const result = [];
    for (const pair of map.items) {
      const keyNode = resolve(pair.key);
      if (!isScalar(keyNode)) continue;
      const key = String(keyNode.value);
      if (key !== "<<") {
        result.push({ key, lower: key.toLowerCase(), value: pair.value });
        continue;
      }
      const source = resolve(pair.value);
      for (const merged of isSeq(source) ? source.items : [source]) result.push(...entries(merged, seen));
    }
    return result;
  };

  /** Every value under `key` (matched case-insensitively), resolved; a key spelled twice yields both. */
  const children = (node, key) =>
    entries(node)
      .filter((entry) => entry.lower === key)
      .map((entry) => resolve(entry.value))
      .filter((value) => value !== undefined);

  const fromSteps = (steps, prefix) => {
    if (!isSeq(steps)) return;
    steps.items.forEach((item, i) => {
      const step = resolve(item);
      const [name] = children(step, "name");
      const named = isScalar(name) && typeof name.value === "string" ? ` (${JSON.stringify(name.value)})` : "";
      for (const node of children(step, "uses")) {
        out.push({ where: `${prefix} step ${i + 1}${named}`, node, level: "step" });
      }
    });
  };

  const root = resolve(doc.contents);
  for (const jobs of children(root, "jobs")) {
    for (const { key: jobId, value } of entries(jobs)) {
      const job = resolve(value);
      for (const node of children(job, "uses")) out.push({ where: `job "${jobId}"`, node, level: "job" });
      for (const steps of children(job, "steps")) fromSteps(steps, `job "${jobId}"`);
    }
  }
  for (const runs of children(root, "runs")) {
    for (const steps of children(runs, "steps")) fromSteps(steps, "composite");
  }
  return { found: out, problems: [...problems] };
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
  const { found, problems } = usesNodes(doc, lineCounter);
  for (const problem of problems) violations.push(`${fileName}:${problem}`);
  for (const { where, node, level } of found) {
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

  it("reports a moving major, which Dependabot would leave stale on a more specific commit", () => {
    for (const comment of ["# v6", "# 6"]) {
      const v = check(step(`pnpm/action-setup@${SHA} ${comment}`)).violations;
      expect(v, comment).toHaveLength(1);
      expect(v[0], comment).toContain(`found ${JSON.stringify(comment)}`);
    }
  });

  it("reports a malformed prerelease or anything after one", () => {
    for (const comment of ["# v2.0.0-", "# v2.0.0-rc.1 beta", "# v2.0.0-rc..1", "# v2.0.0+build.5"]) {
      expect(check(step(`owner/tool@${SHA} ${comment}`)).violations, comment).toHaveLength(1);
    }
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

describe("pinViolations (unusual spellings are read, not skipped)", () => {
  it("reports a Uses: spelled in another case, at step and job level", () => {
    const doc =
      "Jobs:\n  Build:\n    Steps:\n      - Name: Setup\n        Uses: owner/tool@v1\n  call:\n    USES: owner/repo/.github/workflows/x.yml@v2\n";
    const r = check(doc);
    expect(r.thirdParty).toBe(2);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]).toMatch(/^w\.yml:5: job "Build" step 1 \("Setup"\) uses owner\/tool@v1: "v1"/);
    expect(r.violations[1]).toMatch(/^w\.yml:7: job "call" uses owner\/repo\/\.github\/workflows\/x\.yml@v2: "v2"/);
  });

  it("reports both spellings of a key written twice", () => {
    const doc = `jobs:\n  b:\n    steps:\n      - uses: owner/tool@${SHA} # v1.2.3\n        Uses: owner/other@v1\n`;
    const r = check(doc);
    expect(r.thirdParty).toBe(2);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/^w\.yml:5: job "b" step 1 uses owner\/other@v1/);
  });

  it("reports a step aliased from an anchor the walk does not otherwise visit", () => {
    const doc = "env:\n  template: &setup\n    uses: owner/tool@v1\njobs:\n  build:\n    steps:\n      - *setup\n";
    const r = check(doc);
    expect(r.thirdParty).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/^w\.yml:3: job "build" step 1 uses owner\/tool@v1: "v1"/);
  });

  it("reads an aliased uses value, checking the comment on the anchored line", () => {
    const pinned = `env:\n  PIN: &pin owner/tool@${SHA} # v1.2.3\njobs:\n  b:\n    steps:\n      - uses: *pin # v9.9.9 latest\n`;
    expect(check(pinned)).toEqual({ violations: [], thirdParty: 1, localSteps: [] });
    const bare = `env:\n  PIN: &pin owner/tool@${SHA}\njobs:\n  b:\n    steps:\n      - uses: *pin # v1.2.3\n`;
    expect(check(bare).violations[0]).toMatch(
      /^w\.yml:2: job "b" step 1 uses owner\/tool@[0-9a-f]{40} without a same-line/,
    );
  });

  it("reports an aliased job, an aliased steps list and a merged step", () => {
    const doc = [
      "env:",
      "  job: &job",
      "    uses: owner/repo/.github/workflows/x.yml@v2",
      "  steps: &steps",
      "    - uses: owner/listed@v3",
      "  base: &base",
      "    uses: owner/merged@v4",
      "jobs:",
      "  call: *job",
      "  a:",
      "    steps: *steps",
      "  b:",
      "    steps:",
      "      - <<: *base",
      "        name: Merged",
      "",
    ].join("\n");
    const v = check(doc).violations;
    expect(v).toHaveLength(3);
    expect(v[0]).toMatch(/^w\.yml:3: job "call" uses owner\/repo\/\.github\/workflows\/x\.yml@v2/);
    expect(v[1]).toMatch(/^w\.yml:5: job "a" step 1 uses owner\/listed@v3/);
    expect(v[2]).toMatch(/^w\.yml:7: job "b" step 1 \("Merged"\) uses owner\/merged@v4/);
  });

  it("ends an alias cycle and a merge cycle, still reporting what they hold", () => {
    const seq = "jobs:\n  b:\n    steps: &s\n      - *s\n      - uses: owner/tool@v1\n";
    expect(check(seq).violations).toEqual([expect.stringMatching(/^w\.yml:5: job "b" step 2 uses owner\/tool@v1/)]);
    const merge = "jobs:\n  b:\n    steps:\n      - &m { <<: *m, uses: owner/tool@v1 }\n";
    expect(check(merge).violations).toEqual([expect.stringMatching(/^w\.yml:4: job "b" step 1 uses owner\/tool@v1/)]);
  });

  it("reports an alias that names no anchor", () => {
    const v = check("jobs:\n  b:\n    steps:\n      - *nope\n").violations;
    expect(v).toEqual([expect.stringMatching(/^w\.yml:4: alias \*nope does not resolve to a node/)]);
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
      `      - uses: owner/tool/sub@${SHA} # v3.2.0`,
      "",
    ].join("\r\n");
    const r = check(doc);
    expect(r.violations).toEqual([]);
    expect(r.thirdParty).toBe(4);
  });

  it("accepts a tag spelled without the v and a semver prerelease, as Dependabot writes them", () => {
    for (const comment of ["# 1.4.0", "# v2.0.0-rc.1", "# 2.0.0-beta-2", "# v1.2"]) {
      expect(check(step(`owner/tool@${SHA} ${comment}`)).violations, comment).toEqual([]);
    }
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
