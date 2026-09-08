/**
 * The development voice root is a BUILD-TIME marker (#1143), and this guard is
 * what keeps it one. `bin/config.json` may carry `devVoicePacksRoot` only when a
 * gitignored `dev.local.json` sits at the repo root, so a release build cannot
 * carry the mechanism at all — there is no file for it to read.
 *
 * Three properties hold that up, and each is one edit away from being lost:
 * the marker is gitignored (so it can never reach a clone or a tag), the key is
 * emitted through a conditional spread in every plugin's rollup config (never
 * unconditionally), and turbo hashes the marker as a root input (so toggling it
 * cannot be served a stale plugin folder from the cache).
 *
 * Shaped like `third-party-licenses.test.mjs`: the plugin list is discovered
 * from the committed manifests, so a fourth deck ecosystem is covered the day
 * its package appears instead of needing to be added to a list here.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { DEV_VOICE_PACKS_ROOT_KEY } from "./lib/assert-release-build.mjs";
import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE, readDevLocal } from "./lib/dev-local.mjs";
import { allPluginManifestRelPaths } from "./lib/version-discovery.mjs";

// scripts/dev-voice-root-guard.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXAMPLE_FILE = `${DEV_LOCAL_FILE}.example`;

/**
 * The exact conditional spread the emitted config must use. Asserting the text
 * rather than the behaviour is deliberate: the alternative is building three
 * plugins inside a unit test, and what must never happen is the key being
 * emitted unconditionally — a textual property.
 */
const CONDITIONAL_SPREAD =
  "...(devLocal.voicePacksRoot === undefined ? {} : { devVoicePacksRoot: devLocal.voicePacksRoot })";

/** [plugin package dir, package name] pairs, discovered from the committed plugin manifests. */
const PLUGINS = allPluginManifestRelPaths(repoRoot).map((relPath) => {
  const [, pkg] = relPath.split("/");
  const { name, scripts } = JSON.parse(readFileSync(join(repoRoot, "packages", pkg, "package.json"), "utf-8"));
  return [pkg, name, scripts?.["pack:plugin"]];
});

/** The assertion every `pack:plugin` must run FIRST — see `assert-release-build.mjs`. */
const PACK_ASSERTION = "node ../../scripts/assert-release-build.mjs ";

const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf-8"));

const tempRoots = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

describe("the development voice root is build-time only (#1143)", () => {
  it("discovers every plugin package (an empty list would silently skip every per-plugin check)", () => {
    expect(PLUGINS.length).toBeGreaterThanOrEqual(3);
  });

  it("at least one plugin has a pack:plugin script (or the pack assertion below checks nothing)", () => {
    expect(PLUGINS.filter(([, , packScript]) => packScript !== undefined).length).toBeGreaterThan(0);
  });

  it("the pack assertion script exists and is what the pack scripts name", () => {
    // The path is written into three package.json scripts as a string; nothing
    // resolves it until someone packs a release, which is the worst moment to
    // find out it moved.
    expect(existsSync(join(repoRoot, "scripts", "assert-release-build.mjs"))).toBe(true);
    expect(DEV_VOICE_PACKS_ROOT_KEY).toBe("devVoicePacksRoot");
  });

  it(`${DEV_LOCAL_FILE} is gitignored, so it can never reach a clone`, () => {
    const result = spawnSync("git", ["check-ignore", DEV_LOCAL_FILE], { cwd: repoRoot, encoding: "utf-8" });
    expect(result.error, "git must be runnable for this guard to mean anything").toBeUndefined();
    expect(result.status, `${DEV_LOCAL_FILE} must be listed in .gitignore`).toBe(0);
    expect(result.stdout.trim()).toBe(DEV_LOCAL_FILE);
  });

  it(`${DEV_LOCAL_FILE} is not tracked (a tracked file stays tracked despite .gitignore)`, () => {
    const result = spawnSync("git", ["ls-files", "--error-unmatch", DEV_LOCAL_FILE], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    expect(result.status, `${DEV_LOCAL_FILE} must never be committed`).not.toBe(0);
  });

  it(`${EXAMPLE_FILE} is committed and readable through readDevLocal`, () => {
    const root = mkdtempSync(join(tmpdir(), "iracedeck-dev-root-guard-"));
    tempRoots.push(root);
    copyFileSync(join(repoRoot, EXAMPLE_FILE), join(root, DEV_LOCAL_FILE));

    expect(readDevLocal(root)).toEqual({ voicePacksRoot: join(root, ...DEFAULT_DEV_VOICE_PACKS_ROOT.split("/")) });
  });

  describe.each(PLUGINS)("%s", (pkg, packageName, packScript) => {
    const configSource = readFileSync(join(repoRoot, "packages", pkg, "rollup.config.mjs"), "utf-8");
    const pluginSource = readFileSync(join(repoRoot, "packages", pkg, "src", "plugin.ts"), "utf-8");

    it("publishes a pack's `dir` only for a development row", () => {
      // `_voicePacks` rides a run-scoped global into every Property Inspector
      // and the deck-host mirror on every push, and `voice-pack-list.ts`
      // renders `dir` on a development row and nowhere else — so an absolute
      // path on every other row is payload with no reader. Asserted textually,
      // across all three plugins at once, because these regions are required
      // to stay byte-identical and no plugin test reaches the function.
      expect(pluginSource).toContain('...(pack.provenance === "development" ? { dir: pack.dir } : {}),');
      expect(pluginSource, "an unconditional `dir:` would publish it on every row").not.toContain("dir: pack.dir,");
    });

    it("the rollup config reads the marker through the shared helper", () => {
      expect(configSource).toContain(`import { DEV_LOCAL_FILE, readDevLocal } from "../../scripts/lib/dev-local.mjs";`);
      expect(configSource).toContain("const devLocal = readDevLocal(repoRoot);");
    });

    it("emits devVoicePacksRoot only through the conditional spread", () => {
      expect(configSource).toContain(CONDITIONAL_SPREAD);
      // The key must appear nowhere else — an unconditional `devVoicePacksRoot:`
      // would ship the mechanism in a release build.
      const occurrences = configSource.split("devVoicePacksRoot").length - 1;
      expect(occurrences, "devVoicePacksRoot must appear only inside the conditional spread").toBe(1);
    });

    it("packs only a release build, asserted before anything is packed", () => {
      // Conditional on the script EXISTING, because not every plugin has one
      // (Ulanzi is packed by its host's own tooling today) — and the
      // "some plugin has one" test below is what stops that making this
      // vacuous everywhere at once.
      if (packScript === undefined) {
        expect(packScript, `${pkg} has no pack:plugin script — nothing to guard`).toBeUndefined();

        return;
      }

      // FIRST, and chained with `&&`, so a development build stops the whole
      // command rather than being packed and then complained about.
      expect(packScript.startsWith(PACK_ASSERTION), `pack:plugin must start with ${PACK_ASSERTION}`).toBe(true);
      expect(packScript).toContain("/bin/config.json && ");
    });

    it(`turbo hashes ${DEV_LOCAL_FILE} as an input of this plugin's build`, () => {
      const task = turbo.tasks[`${packageName}#build`];
      expect(task, `turbo.json needs a "${packageName}#build" task so the marker is hashed`).toBeDefined();
      expect(task.inputs).toContain("$TURBO_DEFAULT$");
      expect(task.inputs).toContain(`$TURBO_ROOT$/${DEV_LOCAL_FILE}`);
      expect(task.inputs).toContain("$TURBO_ROOT$/scripts/lib/dev-local.mjs");
      // A package-specific entry REPLACES the base task's outputs; an entry
      // without them would stop caching the plugin folder entirely.
      expect(task.outputs?.length, `"${packageName}#build" must declare its outputs`).toBeGreaterThan(0);
    });
  });
});
