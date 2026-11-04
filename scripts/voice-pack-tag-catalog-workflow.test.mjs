/**
 * A deploy refuses a voice-pack catalog behind the live one (#1613).
 *
 * A tag release deploys the site and `packages/audio-assets/catalog/` from the
 * tag. A patch tagged from a release branch cut before a voice-pack bump would
 * put the older entry live over the newer one a between-releases publish
 * already deployed, and nothing would go red: the older archive is still
 * published. `firebase-hosting-release.yml`'s deploying job therefore fetches
 * the live catalog as its last step before the deploy and refuses when any
 * live pack is at a lower version in the catalog it deploys. The base is the
 * live catalog rather than master's, because master routinely carries a pack
 * bump that is not live yet (the spec's amendment). A live pack missing from
 * the deploy is the one question master answers: it passes, with a warning,
 * only when master's catalog lacks it AND master's history shows the entry
 * existed, a withdrawal. A pack master never carried, one a release branch put
 * live, is refused. Master is fetched only then, with its whole history but no
 * file contents, deepening the shallow checkout so a removal older than the
 * tag is seen; a master or a history that cannot be read refuses.
 *
 * The step's place in the job is asserted over the parsed YAML, each assertion
 * positive-controlled against a mutated copy, since an assertion that cannot
 * fail proves nothing. The step itself is run for real, extracted from the
 * YAML, against a local HTTP stand-in for the live catalog and, for the
 * withdrawal cases, in a shallow checkout of a release tag, as actions/checkout
 * leaves one, cloned from a throwaway origin that serves partial clones, as
 * GitHub does, and that it fetches master from. It runs through
 * `runStepAsync`: the stand-in answers on this process's event loop, which a
 * synchronous spawn would hold for the whole run.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildVoiceCatalogData,
  serializeVoiceCatalogData,
  VOICE_CATALOG_ENTRIES_DIR,
} from "./lib/voice-catalog-data.mjs";
import { BASH, createStepSandbox, readWorkflow, REPO, stepNamed, writeFile } from "./lib/workflow-step-runner.mjs";

const HOSTING_WORKFLOW = ".github/workflows/firebase-hosting-release.yml";
const JOB = "build_and_deploy";
const CHECK_STEP = "Refuse a voice-pack catalog behind the live one";
const BUILD_STEP = "Build website";
const LIVE_URL = "https://iracedeck.com/voice-catalog.json";
const CATALOG = "packages/audio-assets/catalog";
/** The tag a release deploys, which every case with an origin checks out. */
const RELEASE_TAG = "v1.0.0";
/** The commit a between-releases publish deploys the catalog of, as publish-voice-packs.yml passes it. */
const PUBLISH_REF = "0123456789abcdef0123456789abcdef01234567";

it("finds a bash to run the workflow step with", () => {
  expect(BASH, "no bash found (on Windows: Git for Windows' bin/bash.exe beside git)").toBeDefined();
});

const deployIndex = (doc) => {
  const index = (doc?.jobs?.[JOB]?.steps ?? []).findIndex(
    (s) => s?.uses?.startsWith("FirebaseExtended/action-hosting-deploy") ?? false,
  );
  if (index === -1) throw new Error(`job "${JOB}" has no Firebase deploy step`);
  return index;
};

/** Each throws when the workflow no longer holds what it names. */
const ASSERTIONS = {
  "is a step of the deploying job": (doc) => {
    stepNamed(doc, JOB, CHECK_STEP);
  },
  "is the step immediately before the Firebase deploy": (doc) => {
    expect(stepNamed(doc, JOB, CHECK_STEP).index).toBe(deployIndex(doc) - 1);
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
  "reads the live catalog from iracedeck.com": (doc) => {
    expect(stepNamed(doc, JOB, CHECK_STEP).step.env?.LIVE_CATALOG_URL).toBe(LIVE_URL);
  },
  // The one expression the step takes, in `env` and never in `run`; it picks the remedy a refusal names.
  "takes the publish's catalog commit from the catalog_ref input": (doc) => {
    expect(stepNamed(doc, JOB, CHECK_STEP).step.env?.CATALOG_REF).toBe("${{ inputs.catalog_ref }}");
  },
};

/** Moves the check step to just before the step at `targetIndex(doc)`, read once the step is out. */
function moveBefore(doc, targetIndex) {
  const steps = doc.jobs[JOB].steps;
  const [step] = steps.splice(stepNamed(doc, JOB, CHECK_STEP).index, 1);
  steps.splice(targetIndex(doc), 0, step);
}

/** [mutation, the assertion it must break, how to apply it to a copy of the doc]. */
const MUTATIONS = [
  [
    "the step removed",
    "is a step of the deploying job",
    (doc) => doc.jobs[JOB].steps.splice(stepNamed(doc, JOB, CHECK_STEP).index, 1),
  ],
  [
    "the step moved before the build",
    "is the step immediately before the Firebase deploy",
    (doc) => moveBefore(doc, (d) => stepNamed(d, JOB, BUILD_STEP).index),
  ],
  [
    "the step moved after the deploy",
    "is the step immediately before the Firebase deploy",
    (doc) => moveBefore(doc, (d) => deployIndex(d) + 1),
  ],
  [
    "another step between it and the deploy",
    "is the step immediately before the Firebase deploy",
    (doc) => doc.jobs[JOB].steps.splice(deployIndex(doc), 0, { run: "echo late" }),
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
  [
    "a different catalog URL",
    "reads the live catalog from iracedeck.com",
    (doc) => (stepNamed(doc, JOB, CHECK_STEP).step.env.LIVE_CATALOG_URL = "https://example.com/voice-catalog.json"),
  ],
  [
    "the env removed",
    "reads the live catalog from iracedeck.com",
    (doc) => delete stepNamed(doc, JOB, CHECK_STEP).step.env,
  ],
  [
    "the catalog ref from another expression",
    "takes the publish's catalog commit from the catalog_ref input",
    (doc) => (stepNamed(doc, JOB, CHECK_STEP).step.env.CATALOG_REF = "${{ github.sha }}"),
  ],
  [
    "the catalog ref removed",
    "takes the publish's catalog commit from the catalog_ref input",
    (doc) => delete stepNamed(doc, JOB, CHECK_STEP).step.env.CATALOG_REF,
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

/**
 * What the stand-in answers on each path: `{ status, body }`, `{ redirect }`
 * (a 302 to that path) or `{ hang: true }` (no answer at all).
 */
const routes = new Map();
let server;
let base;
let box;

beforeAll(async () => {
  box = createStepSandbox("ird-voice-tag-catalog-");
  server = createServer((req, res) => {
    const route = routes.get(req.url);
    if (route === undefined) {
      res.writeHead(599).end("no such route in the test");
    } else if (route.hang) {
      // Never answers; the step's timeout must end the wait.
    } else if (route.redirect) {
      res.writeHead(302, { location: route.redirect }).end();
    } else {
      res.writeHead(route.status, { "content-type": "application/json" }).end(route.body ?? "");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  box?.remove();
});

describe.skipIf(BASH === undefined)("the catalog check step, run against a live stand-in", { timeout: 60_000 }, () => {
  const { step } = stepNamed(readWorkflow(HOSTING_WORKFLOW), JOB, CHECK_STEP);
  let cases = 0;

  /** An entry's file text: a version string becomes `{"version": …}`; `{ raw }` is written as is. */
  const entryText = (value) => (typeof value === "string" ? `${JSON.stringify({ version: value })}\n` : value.raw);

  function writeCatalog(root, catalog) {
    for (const [id, value] of Object.entries(catalog)) writeFile(root, `${CATALOG}/${id}.json`, entryText(value));
  }

  /** A live pack: a version string becomes an entry at that version; `{ pack }` is listed as is. */
  const livePack = (id, value) =>
    typeof value === "string"
      ? { id, label: id, version: value, url: `https://example.invalid/${id}-${value}.zip` }
      : value.pack;

  /** The live catalog's body for `{ id: version }`, shaped as the website generator writes it. */
  const liveBody = (packs) =>
    `${JSON.stringify({ schema: 1, packs: Object.entries(packs).map(([id, value]) => livePack(id, value)) }, null, 2)}\n`;

  /**
   * Runs the step in a fresh directory holding the `deploy` catalog (no catalog
   * directory at all when it is empty), or in `cwd`. The stand-in answers as
   * `live` says: `{ packs }` is a 200 with that catalog, anything else a route
   * as above. `url` overrides where the step looks; `env` adds to its environment.
   * `origin`, one of `origins` below, makes the fresh directory what CI runs
   * the step in: actions/checkout's shallow, single-commit checkout of the
   * release tag, cloned from that origin, with the tag's catalog replaced by
   * `deploy`. Without one the directory is no repository at all, and git is
   * kept from finding one above it.
   */
  async function check({ deploy, live, url, env = {}, cwd, origin }) {
    const id = ++cases;
    const root = cwd ?? path.join(box.work, `case-${id}`);
    if (origin !== undefined) {
      box.git(box.work, "clone", "-q", "--depth=1", "--branch", RELEASE_TAG, origin.url, root);
      // Shallow only from a URL (a plain path clones whole), and with no FETCH_HEAD, which `fetched` reads.
      expect(box.git(root, "rev-parse", "--is-shallow-repository")).toBe("true");
      expect(existsSync(path.join(root, ".git", "FETCH_HEAD"))).toBe(false);
      rmSync(path.join(root, CATALOG), { recursive: true, force: true });
      if (origin.remoteUrl !== undefined) box.git(root, "remote", "set-url", "origin", origin.remoteUrl);
    }
    mkdirSync(root, { recursive: true });
    if (deploy) writeCatalog(root, deploy);
    const route = `/case-${id}/voice-catalog.json`;
    if (live) routes.set(route, live.packs ? { status: 200, body: liveBody(live.packs) } : live);
    const liveUrl = url ?? `${base}${route}`;
    const { status, output } = await box.runStepAsync(step.run, root, {
      LIVE_CATALOG_URL: liveUrl,
      GIT_CEILING_DIRECTORIES: box.work,
      ...env,
    });
    return { status, output, lines: output.split(/\r?\n/), liveUrl, root };
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

  /** A refusal of the whole catalog: one `::error::` line containing `text` and the URL, nothing compared, exit 1. */
  function refusedWhole(run, text) {
    const line = errorLine(run, text);
    expect(line).toContain(run.liveUrl);
    expect(run.lines.some((l) => l.startsWith("ok  "))).toBe(false);
    expect(run.status).toBe(1);
    return line;
  }

  it("refuses a deploy whose pack is behind the live one, naming the pack, both versions, the URL and the remedy", async () => {
    const run = await check({ deploy: { default: "1.3.0" }, live: { packs: { default: "1.4.0" } } });
    const line = errorFor(run, "default");
    expect(line).toContain("is at 1.3.0 in this deploy but live at 1.4.0");
    expect(line).toContain(run.liveUrl);
    expect(line).toContain(
      "from master onto the release branch this deploys, its clips and its catalog entry together",
    );
    expect(line).toContain("then re-tag, or re-run");
    expect(line).not.toContain("Publish voice packs");
    errorLine(run, "1 voice-pack catalog entry in this deploy cannot be deployed");
    expect(run.status).toBe(1);
  });

  it("names master as what must move when a between-releases publish is behind the live catalog", async () => {
    // The publish deploys master's catalog at CATALOG_REF: a release put the newer version live.
    const run = await check({
      deploy: { default: "1.3.0" },
      live: { packs: { default: "1.4.0" } },
      env: { CATALOG_REF: PUBLISH_REF },
    });
    const line = errorFor(run, "default");
    expect(line).toContain("is at 1.3.0 in this deploy but live at 1.4.0");
    expect(line).toContain(
      `This deploy's catalog is master's at ${PUBLISH_REF}, so master is behind the live catalog for pack "default"`,
    );
    expect(line).toContain("Bring the live version onto master first by back-merging the release branch's commits");
    expect(line).toContain("then dispatch 'Publish voice packs' again from master");
    expect(line).not.toContain("onto the release branch this deploys");
    expect(line).not.toContain("re-tag");
    expect(run.status).toBe(1);
  });

  it("passes a deploy at the live version", async () => {
    const run = await check({ deploy: { default: "1.4.0" }, live: { packs: { default: "1.4.0" } } });
    expect(okLine(run, "default")).toBe("ok  default  1.4.0 >= 1.4.0");
    expect(run.output).toContain(`Every voice pack in the live catalog (${run.liveUrl}) is in this deploy`);
    expect(run.output).toContain("1 compared");
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });

  it("passes a deploy ahead of the live version", async () => {
    const run = await check({ deploy: { default: "1.5.0" }, live: { packs: { default: "1.4.0" } } });
    expect(okLine(run, "default")).toBe("ok  default  1.5.0 >= 1.4.0");
    expect(run.status).toBe(0);
  });

  it("passes a pack only the deploy has", async () => {
    const run = await check({ deploy: { default: "1.4.0", early: "1.0.0" }, live: { packs: { default: "1.4.0" } } });
    expect(run.output).not.toContain("::error");
    expect(run.output).toContain("1 compared");
    expect(run.status).toBe(0);
  });

  /**
   * Throwaway origins the withdrawal path fetches master from, by name:
   * `{ url, sha, shas, dir }`. Each runs its branch through a list of commits,
   * each replacing the whole tree; the one called "the release" is tagged
   * `RELEASE_TAG`, which a case checks out. `sha` is the branch's tip, `shas`
   * each commit by its message. Each serves partial clones, as GitHub does,
   * unless `allowFilter` is false. `unreachable` is cloned from a real origin,
   * then pointed at `remoteUrl`, where no repository is.
   */
  const origins = {};
  const entries = (catalog) =>
    Object.fromEntries(Object.entries(catalog).map(([id, value]) => [`${CATALOG}/${id}.json`, entryText(value)]));

  beforeAll(() => {
    /** Replaces the whole tree of `dir` with `files`, commits it as `message` and returns the commit. */
    const commit = (dir, message, files) => {
      box.git(dir, "rm", "-r", "-q", "--ignore-unmatch", ".");
      for (const [rel, text] of Object.entries(files)) writeFile(dir, rel, text);
      box.git(dir, "add", "-A");
      box.git(dir, "commit", "-q", "-m", message);
      return box.git(dir, "rev-parse", "HEAD");
    };
    const makeOrigin = (name, history, { branch = "master", allowFilter = true } = {}) => {
      const dir = path.join(box.work, "origins", name);
      mkdirSync(dir, { recursive: true });
      box.git(dir, "init", "-q", "-b", branch);
      if (allowFilter) box.git(dir, "config", "uploadpack.allowFilter", "true");
      const shas = {};
      for (const [message, files] of history) {
        shas[message] = commit(dir, message, files);
        if (message === "the release") box.git(dir, "tag", RELEASE_TAG);
      }
      origins[name] = { url: pathToFileURL(dir).href, sha: box.git(dir, "rev-parse", "HEAD"), shas, dir };
      return origins[name];
    };
    const site = (text) => ({ "site.txt": `${text}\n` });
    const release = ["the release", { ...site("released site"), ...entries({ default: "1.0.0", legacy: "1.2.0" }) }];

    // Master keeps `legacy`, at a version far below any live one: only the file's presence counts.
    makeOrigin("keeps", [release, ["keeps", entries({ default: "1.0.0", legacy: "0.0.1", fresh: "1.0.0" })]]);
    // Master withdrew `legacy` after the release (and never had `other` or `shipped`). Its tip
    // carries a file the tag lacks, whose contents a blobless fetch leaves behind.
    makeOrigin("withdrew", [release, ["withdrew", { ...site("only on master"), ...entries({ default: "1.0.0" }) }]]);
    // Master withdrew `legacy` BEFORE the release commit, which master's history runs through:
    // below the shallow checkout's boundary.
    const beforeTag = [
      ["legacy added", entries({ default: "1.0.0", legacy: "1.2.0" })],
      ["legacy withdrawn", entries({ default: "1.0.0" })],
      ["the release", { ...site("released site"), ...entries({ default: "1.0.0" }) }],
      ["master moves on", { ...site("master moved on"), ...entries({ default: "1.0.0" }) }],
    ];
    makeOrigin("withdrew-before-tag", beforeTag);
    // The same history from an origin that does not serve partial clones: git fetches the contents too.
    makeOrigin("no-filter", beforeTag, { allowFilter: false });
    // The same history with the commit that added `legacy` gone: master's history cannot be read.
    const corrupt = makeOrigin("corrupt-history", beforeTag);
    const added = corrupt.shas["legacy added"];
    rmSync(path.join(corrupt.dir, ".git", "objects", added.slice(0, 2), added.slice(2)));
    // Master never carried `shipped`: a release branch cut from it shipped the pack, tagged, and
    // was never merged back. The tag's own history has the pack; master's does not.
    const never = makeOrigin("never", [
      ["master starts", entries({ default: "1.0.0" })],
      ["master moves on", { ...site("master moved on"), ...entries({ default: "1.0.0" }) }],
    ]);
    box.git(never.dir, "checkout", "-q", "-b", "release/1.0", never.shas["master starts"]);
    commit(never.dir, "the release", { ...site("released site"), ...entries({ default: "1.0.0", shipped: "1.0.0" }) });
    box.git(never.dir, "tag", RELEASE_TAG);
    box.git(never.dir, "checkout", "-q", "master");
    makeOrigin("no-master", [release, ["main", entries({ default: "1.0.0" })]], { branch: "main" });
    makeOrigin("no-catalog", [release, ["no catalog", site("a master without a catalog directory")]]);
    makeOrigin("catalog-file", [release, ["catalog file", { [CATALOG]: "a file where the directory should be\n" }]]);
    origins.unreachable = {
      url: origins.withdrew.url,
      remoteUrl: pathToFileURL(path.join(box.work, "origins", "no-such-origin")).href,
    };
  }, 60_000);

  /** Whether the step's run left a FETCH_HEAD in the case's repository: whether it fetched at all. */
  const fetched = (run) => existsSync(path.join(run.root, ".git", "FETCH_HEAD"));

  /** The one line naming pack `id`, asserted to be its warning annotation. */
  function warningFor({ lines, output }, id) {
    const named = lines.filter((line) => line.includes(`"${id}"`));
    expect(named, `exactly one line names "${id}" in:\n${output}`).toHaveLength(1);
    expect(named[0].startsWith(`::warning file=${CATALOG}/${id}.json::`), named[0]).toBe(true);
    return named[0];
  }

  it("refuses a live pack missing from the deploy that master still carries: deploying would remove it", async () => {
    const run = await check({
      origin: origins.keeps,
      deploy: { default: "1.4.0" },
      live: { packs: { default: "1.4.0", fresh: "1.0.0" } },
    });
    const line = errorFor(run, "fresh");
    expect(line).toContain("is missing in this deploy but live at 1.0.0");
    expect(line).toContain(
      `master (${origins.keeps.sha}) still carries ${CATALOG}/fresh.json, so it was not withdrawn`,
    );
    expect(okLine(run, "default")).toBeDefined();
    expect(run.status).toBe(1);
  });

  it("refuses a deploy with no catalog directory while packs are live", async () => {
    const run = await check({ deploy: {}, live: { packs: { default: "1.4.0" } } });
    expect(errorFor(run, "default")).toContain("is missing in this deploy");
    expect(run.status).toBe(1);
  });

  describe("a live pack missing from the deploy: master decides whether it was withdrawn", { timeout: 60_000 }, () => {
    /** The objects of `sha`'s history that the case's repository lacks, as `rev-list --missing=print` lists them. */
    const missingObjects = (run, sha) =>
      box
        .git(run.root, "rev-list", "--objects", "--missing=print", sha)
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1));

    it("passes with a warning when master's catalog lacks the pack and its history shows it removed", async () => {
      const run = await check({
        origin: origins.withdrew,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      const line = warningFor(run, "legacy");
      expect(line).toContain(`live at 1.2.0 (${run.liveUrl}), is not in this deploy`);
      expect(line).toContain(`master (${origins.withdrew.sha}) has withdrawn it too`);
      expect(line).toContain(`which its history last touched in ${origins.withdrew.sha} (withdrew)`);
      expect(run.output).not.toContain("::error");
      expect(run.output).toContain("1 compared, 1 withdrawn.");
      expect(fetched(run)).toBe(true);
      expect(run.status).toBe(0);
    });

    it("fetches master's whole history without its file contents", async () => {
      const run = await check({
        origin: origins.withdrew,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      expect(run.status).toBe(0);
      expect(box.git(run.root, "rev-parse", "--is-shallow-repository")).toBe("false");
      // Every commit and tree of master is here; the one file only master's tip carries is not.
      const onlyOnMaster = box.git(origins.withdrew.dir, "rev-parse", `${origins.withdrew.sha}:site.txt`);
      expect(missingObjects(run, origins.withdrew.sha)).toEqual([onlyOnMaster]);
    });

    it("sees a withdrawal older than the release tag, past the shallow checkout's boundary", async () => {
      const origin = origins["withdrew-before-tag"];
      const run = await check({
        origin,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      // The release is on master's history, so a fetch stopping at the checkout's shallow boundary would miss the removal.
      box.git(origin.dir, "merge-base", "--is-ancestor", origin.shas["the release"], origin.sha);
      const line = warningFor(run, "legacy");
      expect(line).toContain(`master (${origin.sha}) has withdrawn it too`);
      expect(line).toContain(`which its history last touched in ${origin.shas["legacy withdrawn"]} (legacy withdrawn)`);
      expect(run.output).not.toContain("::error");
      expect(run.status).toBe(0);
    });

    it("reads master's history from an origin that does not serve partial clones, contents and all", async () => {
      const origin = origins["no-filter"];
      const run = await check({
        origin,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      expect(warningFor(run, "legacy")).toContain(
        `which its history last touched in ${origin.shas["legacy withdrawn"]}`,
      );
      expect(missingObjects(run, origin.sha)).toEqual([]);
      expect(run.status).toBe(0);
    });

    it("refuses a live pack master has never carried, naming the back-merge", async () => {
      const origin = origins.never;
      const run = await check({
        origin,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", shipped: "1.0.0" } },
      });
      // The tag's own history carries the pack; only master's history is asked.
      expect(box.git(run.root, "log", "-1", "--format=%H", "HEAD", "--", `${CATALOG}/shipped.json`)).not.toBe("");
      const line = errorFor(run, "shipped");
      expect(line).toContain("is missing in this deploy but live at 1.0.0");
      expect(line).toContain(
        `master (${origin.sha}) has never carried ${CATALOG}/shipped.json: no commit on its history touches it, so it was not withdrawn there`,
      );
      expect(line).toContain('Back-merge the release branch that put pack "shipped" live onto master first.');
      expect(line).toContain("bring it onto the release branch this deploys too");
      expect(line).toContain(`to withdraw it, delete ${CATALOG}/shipped.json on master and re-run.`);
      expect(line).not.toContain("Publish voice packs");
      expect(run.output).not.toContain("::warning");
      expect(run.status).toBe(1);
    });

    it("refuses a between-releases publish that would remove a pack master has never carried", async () => {
      // A release branch put `shipped` live; master's catalog, which this publish deploys, never had it.
      const origin = origins.never;
      const run = await check({
        origin,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", shipped: "1.0.0" } },
        env: { CATALOG_REF: PUBLISH_REF },
      });
      const line = errorFor(run, "shipped");
      expect(line).toContain(`master (${origin.sha}) has never carried ${CATALOG}/shipped.json`);
      expect(line).toContain(
        `This deploy's catalog is master's at ${PUBLISH_REF}. Back-merge the release branch that put pack "shipped" live onto master`,
      );
      expect(line).toContain("then dispatch 'Publish voice packs' again from master");
      expect(line).toContain("To withdraw the pack instead, it must reach master that way first");
      expect(line).not.toContain("re-tag");
      expect(run.status).toBe(1);
    });

    it("refuses when master still carries the pack, whatever version master has", async () => {
      const run = await check({
        origin: origins.keeps,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      const line = errorFor(run, "legacy");
      expect(line).toContain("is missing in this deploy but live at 1.2.0");
      expect(line).toContain(`master (${origins.keeps.sha}) still carries ${CATALOG}/legacy.json`);
      expect(line).toContain('To keep it, bring pack "legacy" from master onto the release branch');
      expect(line).toContain(`To withdraw it, delete ${CATALOG}/legacy.json on master first, then re-run.`);
      expect(line).not.toContain("Publish voice packs");
      expect(run.output).not.toContain("::warning");
      expect(run.status).toBe(1);
    });

    it("on a between-releases publish, names master, not a release branch, as what decides", async () => {
      // master gained the pack after the commit this publish verified and deploys.
      const run = await check({
        origin: origins.keeps,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
        env: { CATALOG_REF: PUBLISH_REF },
      });
      const line = errorFor(run, "legacy");
      expect(line).toContain(`master (${origins.keeps.sha}) still carries ${CATALOG}/legacy.json`);
      expect(line).toContain(
        `This deploy's catalog is master's at ${PUBLISH_REF}, which has no legacy.json, so master decides.`,
      );
      expect(line).toContain(
        `To keep pack "legacy", make sure master's ${CATALOG} carries legacy.json, then dispatch 'Publish voice packs' again from master`,
      );
      expect(line).toContain(`To withdraw it, make sure master's ${CATALOG} lacks it, then re-run.`);
      expect(line).not.toContain("onto the release branch this deploys");
      expect(run.status).toBe(1);
    });

    it.each([
      ["origin has no master", "no-master", "couldn't find remote ref refs/heads/master"],
      ["origin cannot be reached", "unreachable", "Could not read from remote repository"],
      ["master has no catalog directory", "no-catalog", `has no ${CATALOG} at all`],
      ["master's catalog is a file", "catalog-file", `${CATALOG} (`],
      ["master's history cannot be read", "corrupt-history", "possible repository corruption"],
      ["there is no repository to fetch into", undefined, "not a git repository"],
    ])("refuses, failing closed, when %s", async (_kind, originName, reason) => {
      const run = await check({
        origin: originName === undefined ? undefined : origins[originName],
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      const line = errorFor(run, "legacy");
      expect(line).toContain("is missing in this deploy but live at 1.2.0");
      expect(line).toContain("master could not be read, so its withdrawal cannot be confirmed");
      expect(line).toContain(reason);
      if (originName === "catalog-file") expect(line).toContain("is a blob, not a directory");
      // Master's tip is intact; the history below the release tag is what cannot be fetched.
      if (originName === "corrupt-history")
        expect(line).toContain("fetching refs/heads/master with its history from origin failed");
      expect(run.output).not.toContain("::warning");
      expect(run.status).toBe(1);
    });

    it("refuses, failing closed, when fetching master does not finish in time", async () => {
      const hang = "/hanging-origin.git";
      routes.set(`${hang}/info/refs?service=git-upload-pack`, { hang: true });
      const run = await check({
        origin: { url: origins.withdrew.url, remoteUrl: `${base}${hang}` },
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
        env: { MASTER_GIT_TIMEOUT_MS: "1500" },
      });
      const line = errorFor(run, "legacy");
      expect(line).toContain("master could not be read, so its withdrawal cannot be confirmed");
      expect(line).toContain("git did not finish within 1500 ms");
      expect(run.status).toBe(1);
    });

    it("refuses a git timeout that is not a whole number of milliseconds", async () => {
      const run = await check({
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0" } },
        env: { MASTER_GIT_TIMEOUT_MS: "1.5" },
      });
      errorLine(run, 'MASTER_GIT_TIMEOUT_MS is "1.5"');
      expect(run.status).toBe(1);
    });

    it("does not fetch master when no live pack is missing", async () => {
      const run = await check({
        origin: origins.withdrew,
        deploy: { default: "1.0.0", legacy: "1.2.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0" } },
      });
      expect(fetched(run)).toBe(false);
      expect(run.output).not.toContain("::");
      expect(run.output).toContain("2 compared.");
      expect(run.status).toBe(0);
    });

    it("passes a deploy carrying every live pack even when origin cannot be reached", async () => {
      const run = await check({
        origin: origins.unreachable,
        deploy: { default: "1.0.0" },
        live: { packs: { default: "1.0.0" } },
      });
      expect(run.output).not.toContain("::");
      expect(run.status).toBe(0);
    });

    it("refuses a version rollback even when master has withdrawn the pack, without asking master", async () => {
      const run = await check({
        origin: origins.withdrew,
        deploy: { legacy: "1.4.0" },
        live: { packs: { legacy: "1.5.0" } },
      });
      expect(errorFor(run, "legacy")).toContain("is at 1.4.0 in this deploy but live at 1.5.0");
      expect(run.output).not.toContain("::warning");
      expect(fetched(run)).toBe(false);
      expect(run.status).toBe(1);
    });

    it("reports a withdrawal, a pack behind and a pack master never carried together, and refuses", async () => {
      const run = await check({
        origin: origins.withdrew,
        deploy: { default: "1.0.0", other: "1.0.0" },
        live: { packs: { default: "1.0.0", legacy: "1.2.0", other: "1.1.0", shipped: "1.0.0" } },
      });
      expect(warningFor(run, "legacy")).toContain(`master (${origins.withdrew.sha}) has withdrawn it too`);
      expect(errorFor(run, "other")).toContain("is at 1.0.0 in this deploy but live at 1.1.0");
      expect(errorFor(run, "shipped")).toContain(`master (${origins.withdrew.sha}) has never carried`);
      errorLine(run, "2 voice-pack catalog entries in this deploy cannot be deployed");
      expect(run.status).toBe(1);
    });
  });

  it("reports every problem, not only the first", async () => {
    const run = await check({
      deploy: { alpha: "1.0.0", beta: "2.0.0", gamma: "3.0.0" },
      live: { packs: { alpha: "1.1.0", beta: "2.0.0", gamma: "3.0.1", delta: "1.0.0" } },
    });
    expect(errorFor(run, "alpha")).toContain("is at 1.0.0 in this deploy but live at 1.1.0");
    expect(errorFor(run, "gamma")).toContain("is at 3.0.0 in this deploy but live at 3.0.1");
    expect(errorFor(run, "delta")).toContain("is missing in this deploy but live at 1.0.0");
    expect(okLine(run, "beta")).toBe("ok  beta  2.0.0 >= 2.0.0");
    errorLine(run, "3 voice-pack catalog entries in this deploy cannot be deployed");
    expect(run.status).toBe(1);
  });

  // [deploy, live]: the deploy is at or above the live version under semver precedence.
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

  // [deploy, live]: the deploy is behind the live version under semver precedence.
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

  it("passes every version pair at or above the live one", async () => {
    const run = await check({ deploy: packsOf(AT_OR_ABOVE, 0), live: { packs: packsOf(AT_OR_ABOVE, 1) } });
    AT_OR_ABOVE.forEach(([deploy, live], i) => {
      expect(okLine(run, `case-${i}`), `${JSON.stringify(deploy)} >= ${JSON.stringify(live)}`).toBe(
        `ok  case-${i}  ${deploy} >= ${live}`,
      );
    });
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });

  it("refuses every version pair behind the live one", async () => {
    const run = await check({ deploy: packsOf(BEHIND, 0), live: { packs: packsOf(BEHIND, 1) } });
    BEHIND.forEach(([deploy, live], i) => {
      expect(errorFor(run, `case-${i}`)).toContain(`is at ${deploy} in this deploy but live at ${live}`);
    });
    expect(run.lines.some((line) => line.startsWith("ok  "))).toBe(false);
    errorLine(run, `${BEHIND.length} voice-pack catalog entries in this deploy cannot be deployed`);
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
    ["array", { raw: "[]\n" }, 'no "version"'],
  ])("refuses an unparseable version in the deploy (%s)", async (_kind, version, shown) => {
    const run = await check({ deploy: { default: version }, live: { packs: { default: "1.2.0" } } });
    const line = errorFor(run, "default");
    expect(line).toContain(`${CATALOG}/default.json in this deploy has ${shown}, so pack "default" cannot be compared`);
    expect(line).toContain(`its live 1.2.0 (${run.liveUrl})`);
    expect(run.status).toBe(1);
  });

  it.each([
    ["word", "latest", 'version "latest", which is not a semver version'],
    ["number", { pack: { id: "default", version: 1 } }, "version 1, which is not a semver version"],
    ["absent", { pack: { id: "default" } }, 'no "version"'],
  ])("refuses an unparseable live version (%s), and still checks the rest", async (_kind, version, shown) => {
    const run = await check({
      deploy: { default: "1.2.0", other: "1.0.0" },
      live: { packs: { default: version, other: "1.1.0" } },
    });
    expect(errorFor(run, "default")).toContain(`The live catalog (${run.liveUrl}) lists pack "default" with ${shown}`);
    expect(errorFor(run, "other")).toContain("is at 1.0.0 in this deploy but live at 1.1.0");
    expect(run.status).toBe(1);
  });

  it("refuses an entry in the deploy that is not JSON", async () => {
    const run = await check({ deploy: { default: { raw: "{not json\n" } }, live: { packs: { default: "1.2.0" } } });
    expect(errorFor(run, "default")).toContain(`${CATALOG}/default.json in this deploy could not be read as JSON`);
    expect(run.status).toBe(1);
  });

  it("passes with a warning when no catalog is live (404)", async () => {
    const run = await check({ deploy: { default: "1.0.0" }, live: { status: 404, body: "Not Found" } });
    const warnings = run.lines.filter((line) => line.startsWith("::warning::"));
    expect(warnings, run.output).toHaveLength(1);
    expect(warnings[0]).toContain(`${run.liveUrl} answered HTTP 404`);
    expect(warnings[0]).toContain("no catalog is live");
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });

  it("refuses when the live catalog answers 500", async () => {
    const run = await check({ deploy: { default: "1.0.0" }, live: { status: 500, body: "oops" } });
    refusedWhole(run, "answered HTTP 500");
  });

  it("refuses when the live catalog cannot be reached", async () => {
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${closed.address().port}/voice-catalog.json`;
    await new Promise((resolve) => closed.close(resolve));
    const run = await check({ deploy: { default: "1.0.0" }, url });
    expect(refusedWhole(run, "could not be read")).toContain("ECONNREFUSED");
  });

  it("refuses when the live catalog does not answer in time", async () => {
    const run = await check({
      deploy: { default: "1.0.0" },
      live: { hang: true },
      env: { LIVE_CATALOG_TIMEOUT_MS: "300" },
    });
    refusedWhole(run, "no complete answer within 300 ms");
  });

  it("refuses a timeout that is not a whole number of milliseconds", async () => {
    const run = await check({
      deploy: { default: "1.0.0" },
      live: { packs: { default: "1.0.0" } },
      env: { LIVE_CATALOG_TIMEOUT_MS: "soon" },
    });
    errorLine(run, 'LIVE_CATALOG_TIMEOUT_MS is "soon"');
    expect(run.status).toBe(1);
  });

  it.each([
    ["a body that is not JSON", "<html>maintenance</html>", "its body is not JSON"],
    ["a JSON body that is not an object", "[]", "its body is not a JSON object"],
    ["an unknown schema", JSON.stringify({ schema: 2, packs: [] }), `its "schema" is 2, not 1`],
    ["no schema", JSON.stringify({ packs: [] }), `its "schema" is absent, not 1`],
    ["packs that is not an array", JSON.stringify({ schema: 1, packs: {} }), `its "packs" is {}, not an array`],
    ["a pack that is not an object", JSON.stringify({ schema: 1, packs: ["default"] }), "packs[0] is not an object"],
    [
      "a pack without an id",
      JSON.stringify({ schema: 1, packs: [{ version: "1.0.0" }] }),
      "packs[0] has id absent, not a pack id",
    ],
    [
      "a pack whose id is a path",
      JSON.stringify({ schema: 1, packs: [{ id: "../x", version: "1.0.0" }] }),
      'packs[0] has id "../x", not a pack id',
    ],
    [
      "a pack listed twice",
      JSON.stringify({
        schema: 1,
        packs: [
          { id: "default", version: "1.0.0" },
          { id: "default", version: "0.1.0" },
        ],
      }),
      'packs[1] repeats pack id "default"',
    ],
  ])("refuses a 200 with %s", async (_kind, body, reason) => {
    const run = await check({ deploy: { default: "1.0.0" }, live: { status: 200, body } });
    expect(refusedWhole(run, "cannot be read as the catalog")).toContain(reason);
  });

  it("passes a live catalog with no packs, comparing nothing", async () => {
    const run = await check({ deploy: { default: "1.0.0" }, live: { packs: {} } });
    expect(run.output).toContain("0 compared");
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });

  it("follows a redirect to the catalog", async () => {
    const target = "/redirect-target/voice-catalog.json";
    routes.set(target, { status: 200, body: liveBody({ default: "1.4.0" }) });
    const run = await check({ deploy: { default: "1.4.0" }, live: { redirect: target } });
    expect(okLine(run, "default")).toBe("ok  default  1.4.0 >= 1.4.0");
    expect(run.status).toBe(0);
  });

  it("judges a redirect by its final status", async () => {
    const target = "/redirect-gone/voice-catalog.json";
    routes.set(target, { status: 410, body: "gone" });
    const run = await check({ deploy: { default: "1.4.0" }, live: { redirect: target } });
    expect(refusedWhole(run, "answered HTTP 410")).toContain(`redirected to ${base}${target}`);
  });

  /**
   * The step restates what it reads of the catalog format: schema 1, the
   * pack-id rule and a semver grammar. This serves the website generator's own
   * output for the repository's own entries as the live catalog and deploys
   * those same entries, so a schema bump, a pack-id rule change or a version
   * the step cannot parse turns this red in the change that makes it.
   */
  it("passes the repository's own catalog against the real generator's output of it, comparing every pack", async () => {
    const entriesDir = path.join(REPO, VOICE_CATALOG_ENTRIES_DIR);
    const data = buildVoiceCatalogData(entriesDir);
    expect(
      data.packs.length,
      `${VOICE_CATALOG_ENTRIES_DIR} has no entry, so nothing would be compared`,
    ).toBeGreaterThan(0);
    const root = path.join(box.work, "case-repository-catalog");
    cpSync(entriesDir, path.join(root, CATALOG), { recursive: true });

    const run = await check({ cwd: root, live: { status: 200, body: serializeVoiceCatalogData(data) } });
    for (const { id, version } of data.packs) {
      expect(okLine(run, id), `pack "${id}" was not compared in:\n${run.output}`).toBe(
        `ok  ${id}  ${version} >= ${version}`,
      );
    }
    expect(run.output).toContain(`: ${data.packs.length} compared.`);
    expect(run.output).not.toContain("::");
    expect(run.status).toBe(0);
  });

  it("does not look at master: a pack bump on master that is not live yet passes", async () => {
    // origin: the tag carries default 1.4.0, live too; master has moved on to 1.5.0, not published.
    const root = path.join(box.work, "case-master");
    const origin = path.join(root, "origin");
    mkdirSync(origin, { recursive: true });
    box.git(origin, "init", "-q", "-b", "master");
    writeCatalog(origin, { default: "1.4.0" });
    box.git(origin, "add", "-A");
    box.git(origin, "commit", "-q", "-m", "the release");
    box.git(origin, "tag", "v1.0.0");
    writeCatalog(origin, { default: "1.5.0" });
    box.git(origin, "commit", "-q", "-am", "bump default on master, not published yet");
    const checkout = path.join(root, "checkout");
    box.git(root, "clone", "-q", "--depth=1", "--branch", "v1.0.0", pathToFileURL(origin).href, checkout);

    const run = await check({ cwd: checkout, live: { packs: { default: "1.4.0" } } });
    expect(okLine(run, "default")).toBe("ok  default  1.4.0 >= 1.4.0");
    expect(run.output).not.toContain("::error");
    expect(run.status).toBe(0);
  });
});
