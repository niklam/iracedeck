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
 * local `./…` actions and reusable workflows are exempt only while they are
 * files in this repository.
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
 *   where Dependabot edits it and where a violation points. The comment is
 *   found in the rest of that line the way Dependabot finds it
 *   (`findYamlComment`, a port of its `YamlCommentFinder`), so a flow-map
 *   step `- { uses: owner/tool@<hash> } # v1.2.3` passes while a `#` inside a
 *   quoted scalar after the value is not taken for a comment.
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
 *   its `action.yml`, so one kept outside `.github/actions/` is read too, and
 *   a root `action.yml` / `action.yaml` is scanned whether or not a step uses it.
 * - **`$/` is this repository at the running commit.** GitHub's self repository
 *   reference (`$/.github/actions/x` for a step, `$/.github/workflows/x.yml`
 *   for a job; its recommended form, needing no checkout) resolves to the
 *   repository of the file it appears in, at the commit being run, so it is
 *   neither third-party nor unpinned. A step's `$/path` is followed to its
 *   `action.yml` like a `./` one, and refused when there is none in the tree;
 *   one carrying an `@ref` is refused, as GitHub refuses it.
 * - **A local action must be in the repository.** A step `uses: ./tools/x` with
 *   no `tools/x/action.yml` or `action.yaml` in the tree is code fetched at run
 *   time, typically an `actions/checkout` of another repository into the
 *   workspace at a moving `ref`, which neither this test nor Dependabot reads.
 *   It is refused, with the fix: name it as `owner/repo[/path]@<hash> # <tag>`,
 *   or commit the action here. A path that leaves the repository (`./..`) is
 *   refused the same way.
 * - **Dependabot must be able to see every pin it is asked to keep.** Its
 *   github-actions entry with `directory: "/"` reads `.github/workflows/` and a
 *   root `action.yml` only, so a composite action elsewhere holding a pinned
 *   third-party step would be frozen on its hash: forced there by this test and
 *   never bumped. Every scanned file holding a third-party use must therefore
 *   sit in a directory the entry's `directory` or `directories` names (`/` or
 *   `/.github/workflows` for a workflow; the action's own directory otherwise,
 *   `/` for a root `action.yml`). A singular `directory` is matched literally,
 *   as Dependabot reads it; a `directories` entry also by its `*` (one path
 *   segment) and `**` (any depth) globs. A file whose uses are all first-party
 *   needs no listing.
 *
 * It is proven by positive controls (planted documents that must each be
 * reported) and by coverage floors, so a discovery or parser change that finds
 * nothing cannot stay green.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const REPO = path.join(import.meta.dirname, "..");
/** The real tree on 2026-11-23: 7× pnpm/action-setup, one Firebase deploy, one release upload. */
const MIN_THIRD_PARTY_USES = 9;
/** The real tree on 2026-11-23: ten workflows, no composite actions. */
const MIN_FILES = 10;
/** The real tree on 2026-11-23: the seven workflows holding those nine uses. */
const MIN_FILES_WITH_PINS = 7;

const FULL_SHA = /^[0-9a-f]{40}$/;
/** Applied to the trimmed rest of the line: `# [v]<major>.<minor>[.<patch>…][-<prerelease>]`, nothing else. */
const RELEASE_COMMENT = /^#\s*v?\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** More alias hops than any real document needs; past it the alias is reported as unresolved. */
const MAX_ALIAS_HOPS = 8;

/**
 * Workflow files, composite-action files under `.github/actions/` and a root
 * `action.yml` / `action.yaml`, as names relative to `root` (the repository
 * by default; a test hands in a temporary directory).
 */
function discoverFiles(root = REPO) {
  const files = [];
  const isFile = (rel) => {
    const full = path.join(root, rel);
    return existsSync(full) && statSync(full).isFile();
  };
  for (const manifest of ["action.yml", "action.yaml"]) if (isFile(manifest)) files.push(manifest);
  const workflows = path.join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows)) {
      if (/\.ya?ml$/.test(f) && isFile(`.github/workflows/${f}`)) files.push(`.github/workflows/${f}`);
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
  const actions = path.join(root, ".github", "actions");
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

/**
 * The YAML comment in `suffix` (the rest of a `uses:` line), from its leading
 * whitespace to the end of the line, or undefined when there is none. A port
 * of dependabot-core's `YamlCommentFinder#find` (github_actions
 * `file_updater/workflow_updater/yaml_comment_finder.rb`), which finds the
 * comment Dependabot rewrites: a `#` at index > 0 whose previous character is
 * whitespace, skipping a quoted scalar (`'` or `"` opening when the previous
 * non-whitespace character is absent or one of `:,[{?-`; `''` and a backslash
 * escape inside), so `} # v1.2.3` after a flow map is found and the `#` in
 * `{ a: "x # v1.2.3" }` is not. The one difference is where `suffix` starts:
 * Dependabot's starts after its `uses` declaration pattern, this one after the
 * parsed scalar, closing quote included.
 */
function findYamlComment(suffix) {
  let previousNonWhitespace;
  let index = 0;
  while (index < suffix.length) {
    const character = suffix[index];
    if (
      (character === "'" || character === '"') &&
      (previousNonWhitespace === undefined || ":,[{?-".includes(previousNonWhitespace))
    ) {
      previousNonWhitespace = character;
      index = quotedScalarEnd(suffix, index);
      continue;
    }
    if (character === "#" && index > 0 && /\s/.test(suffix[index - 1])) {
      let start = index;
      while (start > 0 && /\s/.test(suffix[start - 1])) start--;
      return suffix.slice(start);
    }
    if (!/\s/.test(character)) previousNonWhitespace = character;
    index++;
  }
  return undefined;
}

/** The index just past the quoted scalar opening at `quoteIndex`, or the end of `suffix`. */
function quotedScalarEnd(suffix, quoteIndex) {
  const quote = suffix[quoteIndex];
  let index = quoteIndex + 1;
  while (index < suffix.length) {
    const character = suffix[index];
    if (quote === "'" && character === "'" && suffix[index + 1] === "'") index += 2;
    else if (quote === '"' && character === "\\") index += 2;
    else if (character === quote) return index + 1;
    else index++;
  }
  return suffix.length;
}

/**
 * Whether a `uses:` value names this repository's own code: a `./` path in the
 * workspace, or a `$/` self repository reference, which GitHub resolves to
 * this repository at the running commit.
 */
function isLocal(uses) {
  return uses.startsWith("./") || isSelfRef(uses);
}

/** Whether a `uses:` value is a `$/` self repository reference. */
function isSelfRef(uses) {
  return uses.startsWith("$/");
}

/** Whether a non-local `uses:` value names GitHub's first-party `actions` org. */
function isFirstParty(uses) {
  return uses.split("/")[0].toLowerCase() === "actions";
}

/**
 * Checks one parsed document's `uses:` values.
 *
 * @returns {{ violations: string[], thirdParty: number, localSteps: { uses: string, label: string }[] }}
 *   `localSteps` are the step-level `./…` values and where they are, for the caller to follow.
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
    if (isSelfRef(uses) && uses.includes("@")) {
      violations.push(
        `${label} uses ${uses}: a $/ reference must not carry an @ref, since it always resolves to the running commit (GitHub refuses one)`,
      );
      continue;
    }
    if (isLocal(uses)) {
      if (level === "step") localSteps.push({ uses, label });
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
    const comment = findYamlComment(restOfLine(source, node))?.trim();
    if (comment === undefined || !RELEASE_COMMENT.test(comment)) {
      const found = comment === undefined ? "no comment on that line" : JSON.stringify(comment);
      violations.push(`${label} uses ${uses} without a same-line release comment like "# v1.2.3" (found ${found})`);
    }
  }
  return { violations, thirdParty, localSteps };
}

const DEPENDABOT = ".github/dependabot.yml";

/**
 * The directories Dependabot's github-actions entries name: a singular
 * `directory` is literal, and only a `directories` entry may be a glob.
 *
 * @returns {{ entries: number, directories: { value: string, glob: boolean }[], violations: string[] }}
 */
function dependabotActionDirectories(source) {
  if (source === undefined) return { entries: 0, directories: [], violations: [`${DEPENDABOT} does not exist`] };
  const doc = parseDocument(source);
  const violations = doc.errors.map((error) => `${DEPENDABOT}: does not parse as YAML: ${error.message}`);
  const updates = doc.toJS()?.updates;
  const entries = Array.isArray(updates) ? updates.filter((u) => u?.["package-ecosystem"] === "github-actions") : [];
  const directories = [];
  for (const entry of entries) {
    if (typeof entry.directory === "string") directories.push({ value: entry.directory, glob: false });
    if (Array.isArray(entry.directories)) {
      for (const d of entry.directories) if (typeof d === "string") directories.push({ value: d, glob: true });
    }
  }
  if (entries.length === 0) violations.push(`${DEPENDABOT} has no github-actions entry, so no pin is ever bumped`);
  return { entries: entries.length, directories, violations };
}

/** `/a/b/`, `a/b` and `./a/b` all as `/a/b`; the root (`.`, `/`, ``) as `/`. */
function normalizeDir(dir) {
  const normal = path.posix.normalize(`/${dir}`);
  return normal.length > 1 ? normal.replace(/\/+$/, "") : "/";
}

/**
 * Whether a Dependabot directory names `dir`: a literal one (`directory`)
 * exactly, a `directories` entry also by its `*` (one segment) and `**` (any
 * depth) globs. A globstar covers its own layer as well as every one below it,
 * so `/ci/**` names `/ci` and `/ci/**` + `/setup` names `/ci/setup`: a `/**`
 * segment matches zero or more whole segments.
 */
function dirMatches({ value, glob }, dir) {
  if (!glob) return normalizeDir(value) === dir;
  // A Map, not an object literal: a literal segment such as `__proto__` must
  // never read an inherited property in place of its own escaped text.
  const GLOB_PARTS = new Map([
    ["/**", "(?:/.*)?"],
    ["**", ".*"],
    ["*", "[^/]*"],
  ]);
  const regex = normalizeDir(value)
    .split(/(\/\*\*(?=\/|$)|\*\*|\*)/)
    .map((part) => GLOB_PARTS.get(part) ?? part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${regex}$`).test(dir);
}

/** The directories any one of which lets Dependabot read `file`'s pins. */
function dependabotDirsFor(file) {
  if (/^\.github\/workflows\/[^/]+$/.test(file)) return ["/", "/.github/workflows"];
  return [normalizeDir(path.posix.dirname(file))];
}

/**
 * Walks `seeds` and every local step action they name, each file once, and
 * checks Dependabot's github-actions entry covers each file holding a
 * third-party use. `read(relPath)` returns the file's text, or undefined when
 * there is none; `.github/dependabot.yml` is read through it too.
 */
function scan(seeds, read) {
  const violations = [];
  const visited = new Set();
  let thirdParty = 0;
  let coverageChecked = 0;
  const dependabot = dependabotActionDirectories(read(DEPENDABOT));
  violations.push(...dependabot.violations);
  const listed = JSON.stringify(dependabot.directories.map((d) => d.value));
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
    const wanted = dependabotDirsFor(file);
    if (r.thirdParty > 0) {
      coverageChecked++;
      if (!dependabot.directories.some((d) => wanted.some((w) => dirMatches(d, w)))) {
        violations.push(
          `${file} holds ${r.thirdParty} third-party uses, but ${DEPENDABOT}'s github-actions entry does not cover ${wanted[0]} (it lists ${listed}), so their hashes would never be bumped; add "${wanted[0]}" to that entry's directories`,
        );
      }
    }
    for (const { uses, label } of r.localSteps) {
      const self = isSelfRef(uses);
      const dir = path.posix.normalize(self ? `./${uses.slice(2)}` : uses).replace(/\/+$/, "");
      const candidates = dir === "." ? ["action.yml", "action.yaml"] : [`${dir}/action.yml`, `${dir}/action.yaml`];
      const target = dir.startsWith("..") ? undefined : candidates.find((f) => read(f) !== undefined);
      if (target !== undefined) {
        queue.push(target);
      } else if (self) {
        violations.push(
          `${label} uses ${uses}, which is not an action in this repository (no ${candidates.join(" or ")}); a $/ reference resolves to this repository at the running commit, so the action must be committed here`,
        );
      } else {
        violations.push(
          `${label} uses ${uses}, which is not an action in this repository (no ${candidates.join(" or ")}), so it is code fetched at run time that nothing here pins or bumps; name it as owner/repo[/path]@<40-hex commit> # <release>, or commit it here`,
        );
      }
    }
  }
  return { violations, thirdParty, visited, coverageChecked, dependabotEntries: dependabot.entries };
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

  it("reads a github-actions entry in .github/dependabot.yml and checks it covers every file with a pin", () => {
    expect(result.dependabotEntries).toBeGreaterThanOrEqual(1);
    expect(result.coverageChecked).toBeGreaterThanOrEqual(MIN_FILES_WITH_PINS);
    expect(result.violations.filter((v) => v.includes("would never be bumped"))).toEqual([]);
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

  it("reports a $/ reference carrying an @ref, at step and job level", () => {
    const doc =
      "jobs:\n  call:\n    uses: $/.github/workflows/x.yml@v1\n  b:\n    steps:\n      - uses: $/.github/actions/x@main\n";
    const r = check(doc);
    expect(r.thirdParty).toBe(0);
    expect(r.localSteps).toEqual([]);
    expect(r.violations).toEqual([
      expect.stringMatching(
        /^w\.yml:3: job "call" uses \$\/\.github\/workflows\/x\.yml@v1: a \$\/ reference must not carry an @ref/,
      ),
      expect.stringMatching(/^w\.yml:6: job "b" step 1 uses \$\/\.github\/actions\/x@main: a \$\/ reference must not/),
    ]);
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

describe("pinViolations (the release comment is found as Dependabot finds it)", () => {
  const flow = (body) => `jobs:\n  b:\n    steps:\n      - ${body}\n`;

  it("accepts a release comment after a flow map's closing brace", () => {
    expect(check(flow(`{ uses: owner/tool@${SHA} } # v1.2.3`))).toEqual({
      violations: [],
      thirdParty: 1,
      localSteps: [],
    });
  });

  it("still refuses a tag inside a flow map, whatever its comment", () => {
    expect(check(flow("{ uses: owner/tool@v1 } # v1.2.3")).violations).toEqual([
      expect.stringMatching(/^w\.yml:4: job "b" step 1 uses owner\/tool@v1: "v1" is not a full/),
    ]);
  });

  it("does not take a # inside a quoted scalar for the comment", () => {
    const v = check(flow(`{ uses: owner/tool@${SHA}, with: { a: "x # v1.2.3" } }`)).violations;
    expect(v).toEqual([
      expect.stringMatching(/without a same-line release comment .*\(found no comment on that line\)$/),
    ]);
    const single = check(flow(`{ uses: owner/tool@${SHA}, with: { a: 'x # v1.2.3' } }`)).violations;
    expect(single).toEqual([expect.stringMatching(/found no comment on that line/)]);
  });

  it("finds the real comment after a quoted # , through escaped quotes", () => {
    for (const quoted of [`"x # v9.9.9"`, `"a \\" # v9.9.9"`, `'it''s # v9.9.9'`]) {
      const doc = flow(`{ uses: owner/tool@${SHA}, with: { a: ${quoted} } } # v1.2.3`);
      expect(check(doc).violations, quoted).toEqual([]);
      const bad = flow(`{ uses: owner/tool@${SHA}, with: { a: ${quoted} } } # pinned`);
      expect(check(bad).violations, quoted).toEqual([expect.stringMatching(/\(found "# pinned"\)$/)]);
    }
  });

  it("matches dependabot-core's finder on its edge cases", () => {
    expect(findYamlComment(" # v1.2.3")).toBe(" # v1.2.3");
    expect(findYamlComment("   #v0.11.0")).toBe("   #v0.11.0");
    expect(findYamlComment("# v1.2.3")).toBeUndefined();
    expect(findYamlComment(" }# v1.2.3")).toBeUndefined();
    expect(findYamlComment(' } # a "b" # c')).toBe(' # a "b" # c');
    expect(findYamlComment(' x"y # v1.2.3')).toBe(" # v1.2.3");
    expect(findYamlComment(', a: "unterminated # v1.2.3')).toBeUndefined();
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
    expect(check(doc)).toEqual({
      violations: [],
      thirdParty: 0,
      localSteps: [{ uses: "./x", label: 'w.yml:6: job "b" step 1' }],
    });
  });

  it("accepts $/ self repository references at step and job level, and hands the step ones back", () => {
    const doc =
      "jobs:\n  call:\n    uses: $/.github/workflows/x.yml\n  b:\n    steps:\n      - uses: $/.github/actions/x\n";
    expect(check(doc)).toEqual({
      violations: [],
      thirdParty: 0,
      localSteps: [{ uses: "$/.github/actions/x", label: 'w.yml:6: job "b" step 1' }],
    });
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

const WF = ".github/workflows/w.yml";
const dependabotYml = (...entries) =>
  `version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n${entries.join("")}`;
const actionsEntry = (dirs) =>
  `  - package-ecosystem: "github-actions"\n${typeof dirs === "string" ? `    directory: "${dirs}"\n` : `    directories:\n${dirs.map((d) => `      - "${d}"\n`).join("")}`}`;
const composite = (uses) => `runs:\n  using: composite\n  steps:\n    - uses: ${uses}\n`;
/** An in-memory repository; `dependabot: null` means it has no `.github/dependabot.yml`. */
const tree =
  (files, dependabot = dependabotYml(actionsEntry("/"))) =>
  (rel) =>
    rel === DEPENDABOT ? (dependabot ?? undefined) : files[rel];

describe("scan (local actions, in-memory tree)", () => {
  it("follows a local step action and reports its tag-pinned step", () => {
    const r = scan(
      [WF],
      tree(
        { [WF]: step("./ci/setup"), "ci/setup/action.yml": composite("owner/tool@v1") },
        dependabotYml(actionsEntry(["/", "/ci/setup"])),
      ),
    );
    expect([...r.visited].sort()).toEqual([WF, "ci/setup/action.yml"]);
    expect(r.thirdParty).toBe(1);
    expect(r.violations).toEqual([
      expect.stringMatching(/^ci\/setup\/action\.yml:4: composite step 1 uses owner\/tool@v1/),
    ]);
  });

  it("reports a dangling local action and survives a cycle", () => {
    const self = "runs:\n  using: composite\n  steps:\n    - uses: ./a\n    - uses: ./missing\n";
    const r = scan([WF], tree({ [WF]: step("./a"), "a/action.yml": self }));
    expect(r.violations).toEqual([
      expect.stringMatching(
        /^a\/action\.yml:5: composite step 2 uses \.\/missing, which is not an action in this repository/,
      ),
    ]);
    expect([...r.visited].sort()).toEqual([WF, "a/action.yml"]);
  });

  it("reports an action checked out at run time and then used as a local path", () => {
    const doc = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "        with:",
      "          repository: owner/tool",
      "          ref: v1",
      "          path: tools/x",
      "      - uses: ./tools/x",
      "",
    ].join("\n");
    const r = scan([WF], tree({ [WF]: doc }));
    expect(r.thirdParty).toBe(0);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(
      /^\.github\/workflows\/w\.yml:9: job "build" step 2 uses \.\/tools\/x, which is not an action in this repository \(no tools\/x\/action\.yml or tools\/x\/action\.yaml\), so it is code fetched at run time/,
    );
    expect(r.violations[0]).toMatch(/name it as owner\/repo\[\/path\]@<40-hex commit> # <release>/);
  });

  it("follows a $/ step action and reports its tag-pinned step", () => {
    const action = ".github/actions/hello/action.yml";
    const r = scan(
      [WF],
      tree(
        { [WF]: step("$/.github/actions/hello"), [action]: composite("owner/tool@v1") },
        dependabotYml(actionsEntry(["/", "/.github/actions/hello"])),
      ),
    );
    expect([...r.visited].sort()).toEqual([action, WF]);
    expect(r.violations).toEqual([
      expect.stringMatching(/^\.github\/actions\/hello\/action\.yml:4: composite step 1 uses owner\/tool@v1/),
    ]);
  });

  it("reports a $/ step action with no manifest, without calling it a run-time checkout", () => {
    const r = scan([WF], tree({ [WF]: step("$/.github/actions/missing") }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(
      /^\.github\/workflows\/w\.yml:5: job "build" step 2 uses \$\/\.github\/actions\/missing, which is not an action in this repository \(no \.github\/actions\/missing\/action\.yml or \.github\/actions\/missing\/action\.yaml\); a \$\/ reference resolves to this repository at the running commit/,
    );
    expect(r.violations[0]).not.toMatch(/fetched at run time/);
    const outside = scan([WF], tree({ [WF]: step("$/../elsewhere") }));
    expect(outside.violations).toEqual([expect.stringMatching(/uses \$\/\.\.\/elsewhere, which is not an action/)]);
  });

  it("does not follow a job-level $/ reusable workflow", () => {
    const doc = "jobs:\n  call:\n    uses: $/.github/workflows/other.yml\n";
    const r = scan([WF], tree({ [WF]: doc }));
    expect(r.violations).toEqual([]);
    expect([...r.visited]).toEqual([WF]);
  });

  it("reports a local path that leaves the repository, and finds a root action.yml", () => {
    const outside = scan([WF], tree({ [WF]: step("./../elsewhere"), "../elsewhere/action.yml": composite("./x") }));
    expect(outside.violations).toEqual([
      expect.stringMatching(/uses \.\/\.\.\/elsewhere, which is not an action in this repository/),
    ]);
    const root = scan([WF], tree({ [WF]: step("./"), "action.yml": "runs:\n  using: composite\n  steps: []\n" }));
    expect(root.violations).toEqual([]);
    expect([...root.visited].sort()).toEqual([WF, "action.yml"]);
  });
});

describe("scan (Dependabot sees every pin)", () => {
  const ACTION = ".github/actions/setup/action.yml";
  const pinned = composite(`owner/tool@${SHA} # v1.2.3`);

  it("reports a composite action holding a pinned third-party step in a directory Dependabot does not read", () => {
    const r = scan([WF, ACTION], tree({ [WF]: step(`owner/tool@${SHA} # v1.2.3`), [ACTION]: pinned }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(
      /^\.github\/actions\/setup\/action\.yml holds 1 third-party uses, but \.github\/dependabot\.yml's github-actions entry does not cover \/\.github\/actions\/setup \(it lists \["\/"\]\)/,
    );
    expect(r.violations[0]).toMatch(/add "\/\.github\/actions\/setup" to that entry's directories$/);
  });

  it("passes it once directories lists it, exactly or by a * or ** glob", () => {
    for (const dirs of [
      ["/", "/.github/actions/setup"],
      ["/", ".github/actions/setup/"],
      ["/", "/.github/actions/*"],
      ["/**"],
    ]) {
      const r = scan(
        [WF, ACTION],
        tree({ [WF]: step(`owner/tool@${SHA} # v1.2.3`), [ACTION]: pinned }, dependabotYml(actionsEntry(dirs))),
      );
      expect(r.violations, JSON.stringify(dirs)).toEqual([]);
    }
  });

  it("does not let * cross a path segment", () => {
    const deep = ".github/actions/group/setup/action.yml";
    const r = scan([deep], tree({ [deep]: pinned }, dependabotYml(actionsEntry(["/", "/.github/actions/*"]))));
    expect(r.violations).toEqual([expect.stringMatching(/does not cover \/\.github\/actions\/group\/setup/)]);
  });

  it("lets a /** segment match zero or more whole segments, and nothing else", () => {
    const covers = (value, dir) => dirMatches({ value, glob: true }, dir);
    expect(covers("/ci/**/setup", "/ci/setup")).toBe(true);
    expect(covers("/ci/**/setup", "/ci/group/setup")).toBe(true);
    expect(covers("/ci/**/setup", "/ci/a/b/setup")).toBe(true);
    expect(covers("/ci/**/setup", "/cix/setup")).toBe(false);
    expect(covers("/ci/**/setup", "/ci/setupx")).toBe(false);
    expect(covers("/.github/actions/**", "/.github/actions")).toBe(true);
    expect(covers("/.github/actions/**", "/.github/actions/group/setup")).toBe(true);
    expect(covers("/.github/actions/**", "/.github/actionsx")).toBe(false);
    expect(covers("/**", "/")).toBe(true);
    expect(covers("/ci/*/setup", "/ci/setup")).toBe(false);
    expect(dirMatches({ value: "/ci/**", glob: false }, "/ci")).toBe(false);
  });

  it("treats a literal segment named like an Object property as text", () => {
    const covers = (value, dir) => dirMatches({ value, glob: true }, dir);
    expect(covers("/ci/*__proto__", "/ci/test")).toBe(false);
    expect(covers("/ci/*__proto__", "/ci/x__proto__")).toBe(true);
    expect(covers("/ci/constructor", "/ci/x")).toBe(false);
    expect(covers("/ci/toString/*", "/ci/toString/a")).toBe(true);
  });

  it("needs no listing for a composite action with only first-party steps", () => {
    const r = scan([ACTION], tree({ [ACTION]: composite("actions/setup-node@v6") }));
    expect(r.violations).toEqual([]);
  });

  it("reports a workflow's pins when the entry does not read the workflows", () => {
    const r = scan([WF], tree({ [WF]: step(`owner/tool@${SHA} # v1.2.3`) }, dependabotYml(actionsEntry("/tools"))));
    expect(r.violations).toEqual([
      expect.stringMatching(/^\.github\/workflows\/w\.yml holds 1 third-party uses, .*add "\/" to/),
    ]);
    const listed = dependabotYml(actionsEntry(["/.github/workflows"]));
    expect(scan([WF], tree({ [WF]: step(`owner/tool@${SHA} # v1.2.3`) }, listed)).violations).toEqual([]);
  });

  it("reads a singular directory literally, as Dependabot does", () => {
    const files = { [WF]: step(`owner/tool@${SHA} # v1.2.3`), [ACTION]: pinned };
    const star = scan([WF], tree(files, dependabotYml(actionsEntry("/*"))));
    expect(star.violations).toEqual([
      expect.stringMatching(/w\.yml holds 1 third-party uses, .*does not cover \/ \(it lists \["\/\*"\]\)/),
    ]);
    const actionsStar = scan([ACTION], tree(files, dependabotYml(actionsEntry("/.github/actions/*"))));
    expect(actionsStar.violations).toEqual([expect.stringMatching(/does not cover \/\.github\/actions\/setup/)]);
    const exact = scan([ACTION], tree(files, dependabotYml(actionsEntry(".github/actions/setup/"))));
    expect(exact.violations).toEqual([]);
  });

  it("needs / listed for a root action.yml holding a third-party pin", () => {
    const files = { "action.yml": pinned };
    expect(scan(["action.yml"], tree(files)).violations).toEqual([]);
    const r = scan(["action.yml"], tree(files, dependabotYml(actionsEntry(["/.github/workflows"]))));
    expect(r.violations).toEqual([
      expect.stringMatching(/^action\.yml holds 1 third-party uses, .*does not cover \/ .*add "\/" to/),
    ]);
  });

  it("reports a missing dependabot.yml or one without a github-actions entry", () => {
    const files = { [WF]: step("actions/checkout@v7") };
    expect(scan([WF], tree(files, null)).violations).toEqual([".github/dependabot.yml does not exist"]);
    const npmOnly = scan([WF], tree(files, dependabotYml()));
    expect(npmOnly.dependabotEntries).toBe(0);
    expect(npmOnly.violations).toEqual([expect.stringMatching(/has no github-actions entry/)]);
  });
});

describe("discoverFiles (a temporary repository on disk)", () => {
  it("seeds a root action.yml or action.yaml that no step uses, and scan reports its pins", () => {
    for (const manifest of ["action.yml", "action.yaml"]) {
      const root = mkdtempSync(path.join(tmpdir(), "action-pins-"));
      try {
        mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
        mkdirSync(path.join(root, ".github", "actions", "setup"), { recursive: true });
        writeFileSync(path.join(root, ".github", "workflows", "w.yml"), step("actions/checkout@v7"));
        writeFileSync(
          path.join(root, ".github", "actions", "setup", "action.yaml"),
          composite("actions/setup-node@v6"),
        );
        writeFileSync(path.join(root, ".github", "dependabot.yml"), dependabotYml(actionsEntry("/")));
        writeFileSync(path.join(root, manifest), composite("owner/tool@v1"));
        const files = discoverFiles(root);
        expect(files.sort(), manifest).toEqual([".github/actions/setup/action.yaml", WF, manifest].sort());
        const read = (rel) => {
          const full = path.join(root, rel);
          return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
        };
        expect(scan(files, read).violations, manifest).toEqual([
          expect.stringMatching(new RegExp(`^${manifest.replace(".", "\\.")}:4: composite step 1 uses owner/tool@v1`)),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
