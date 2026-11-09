import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { assertReleaseBuild as realAssertReleaseBuild } from "./assert-release-build.mjs";
import { CHANGELOG_SOURCE_PATH } from "./changelog-data.mjs";
import { DEV_LOCAL_FILE, DEV_VOICES_ENV } from "./dev-local.mjs";
import {
  BUILD_FILTER,
  cleanCommand,
  createOutputTail,
  describeBuildCommand,
  developerTreeMarkers,
  FEATURE_FLAGS_LOCAL_FILE,
  PLUGIN_CONFIG_REL,
  releaseCapture,
  RESTORE_COMMAND,
  runTeed,
  unexpectedTrackedChanges,
} from "./release-capture.mjs";
import { CAPTURE_MANIFEST_FILE, sha256Hex } from "./settings-window-capture/capture-manifest.mjs";
import { CapturePreconditionError, committedCaptureDir } from "./settings-window-capture/run-capture.mjs";
import { SETTINGS_WINDOW_TABS } from "./settings-window-capture/tabs.mjs";

const ROOT = path.join("/repo");
/** A real folder for the tests that start a child process. */
const ROOT_CWD = import.meta.dirname;
const FOLDER = committedCaptureDir(ROOT);
const FOLDER_REL = "packages/website/src/assets/settings-window";
const VERSION = "3.9.0";

/** The folded changelog `before:bump` left: the new section above the last release. */
const FOLDED_MDX = `---
title: Changelog
---

Release notes.

## 3.9.0

_2026-11-09_

**Features**

- A feature.

## 3.8.1

_2026-10-01_

**Bug Fixes**

- A fix.
`;

const HEAD_MDX = FOLDED_MDX.replace(/## 3\.9\.0[\s\S]*?(?=## 3\.8\.1)/, "");

/** A path under ROOT as the fake tree keys it: relative, forward slashes. */
const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join("/");
const encode = (text) => new TextEncoder().encode(text);
const asBytes = (content) => (typeof content === "string" ? encode(content) : content);
const asText = (content) => (typeof content === "string" ? content : new TextDecoder().decode(content));

/**
 * HEAD and the working tree `before:bump` left behind: the version files
 * bumped, `changelog.mdx` folded, the fragment removed, a voice-pack record
 * sealed. The screenshot folder holds the previous release's PNGs and manifest.
 */
function trees() {
  const head = {
    "package.json": '{"version":"3.9.0-dev.0"}\n',
    "packages/demo/package.json": '{"version":"3.9.0-dev.0"}\n',
    [CHANGELOG_SOURCE_PATH]: HEAD_MDX,
    "changelog.d/1-feature.md": "---\ncategory: Features\nweight: 50\n---\n\nA feature.\n",
    "packages/audio-assets/pack-records/demo.json": '{"released":false}\n',
    "packages/foo/generated.json": "from HEAD\n",
    [`${PLUGIN_CONFIG_REL}`]: "{}\n",
  };
  for (const { file } of SETTINGS_WINDOW_TABS) head[`${FOLDER_REL}/${file}`] = `png:${file}@3.8.1`;
  head[`${FOLDER_REL}/${CAPTURE_MANIFEST_FILE}`] = '{"version":"3.8.1","files":{}}\n';

  const files = { ...head };
  files["package.json"] = `{"version":"${VERSION}"}\n`;
  files["packages/demo/package.json"] = `{"version":"${VERSION}"}\n`;
  files[CHANGELOG_SOURCE_PATH] = FOLDED_MDX;
  delete files["changelog.d/1-feature.md"];
  files["packages/audio-assets/pack-records/demo.json"] = '{"released":true}\n';

  return { head, files };
}

/**
 * Every collaborator faked over `trees()`, each pushing its step onto `trace`.
 * `git` answers the three commands the hook uses from the fake tree, the way
 * git would: `diff HEAD` names every path whose content differs from HEAD,
 * `hash-object` hashes the working-tree content, `add` is recorded.
 */
function fakes({ env = {}, build, capture, assertReleaseBuild, head: headOverride, files: filesOverride } = {}) {
  const { head, files } = trees();
  Object.assign(head, headOverride);
  Object.assign(files, filesOverride);
  for (const [name, content] of Object.entries(filesOverride ?? {})) if (content === undefined) delete files[name];

  const trace = [];
  const log = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();

  const fs = {
    existsSync: vi.fn((absolute) => {
      const name = rel(absolute);
      if (name === FEATURE_FLAGS_LOCAL_FILE || name === DEV_LOCAL_FILE) trace.push(`devtree:${name}`);

      return Object.hasOwn(files, name);
    }),
    readdirSync: vi.fn((absolute) => {
      const dir = rel(absolute);

      return Object.keys(files)
        .filter((name) => path.posix.dirname(name) === dir)
        .map((name) => path.posix.basename(name));
    }),
    readFileSync: vi.fn((absolute, encoding) => {
      const name = rel(absolute);
      if (!Object.hasOwn(files, name)) throw new Error(`ENOENT: ${name}`);

      return encoding === undefined ? asBytes(files[name]) : asText(files[name]);
    }),
    writeFileSync: vi.fn((absolute, data) => {
      const name = rel(absolute);
      trace.push(`write:${name}`);
      files[name] = data;
    }),
  };

  const git = vi.fn((root, args, input) => {
    expect(root).toBe(ROOT);
    if (args[0] === "diff") {
      trace.push("snapshot");
      const names = new Set([...Object.keys(head), ...Object.keys(files)]);

      return [...names]
        .filter((name) => asText(head[name] ?? "\0head-missing") !== asText(files[name] ?? "\0file-missing"))
        .join("\0");
    }
    if (args[0] === "hash-object") {
      return input
        .split("\n")
        .filter((name) => name !== "")
        .map((name) => sha256Hex(asBytes(files[name])))
        .join("\n");
    }
    if (args[0] === "add") {
      trace.push(`stage:${args.slice(2).join(" ")}`);

      return "";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  });

  const deps = {
    root: ROOT,
    env,
    fs,
    // A fake `build` may return a bare exit code, or the whole BuildResult to
    // hand back an output tail.
    build: vi.fn(async (root) => {
      trace.push("build");
      const result = build === undefined ? 0 : build(root, { files, head });

      return typeof result === "number" ? { status: result, outputTail: [] } : result;
    }),
    assertReleaseBuild: vi.fn((configPath) => {
      trace.push("assert");

      return assertReleaseBuild === undefined ? 0 : assertReleaseBuild(configPath);
    }),
    runCapture: vi.fn(async (options) => {
      trace.push("capture");
      if (capture !== undefined) return capture(options, { files });

      const written = [];
      for (const { file } of SETTINGS_WINDOW_TABS) {
        files[`${FOLDER_REL}/${file}`] = `png:${file}@${options.expectVersion}`;
        written.push(path.join(options.outDir, file));
      }

      return { written, skipped: [] };
    }),
    git,
    log,
    warn,
    error,
  };

  const errors = () => error.mock.calls.map(([line]) => line).join("\n");
  const logs = () => log.mock.calls.map(([line]) => line).join("\n");
  const staged = () => trace.filter((step) => step.startsWith("stage:"));

  return { deps, trace, files, head, errors, logs, staged };
}

const STEPS = [
  `devtree:${FEATURE_FLAGS_LOCAL_FILE}`,
  `devtree:${DEV_LOCAL_FILE}`,
  "snapshot",
  "build",
  "assert",
  "capture",
  `write:${FOLDER_REL}/${CAPTURE_MANIFEST_FILE}`,
  "snapshot",
  `stage:${FOLDER_REL}`,
];

/**
 * Every failure: nothing staged, the two restore commands named — as literals,
 * so a wrong constant cannot agree with itself. Verified in a throwaway
 * repository: `git restore --staged --worktree -- :/` returns every tracked
 * change (staged deletions and modifications included) and leaves an untracked
 * file, which the `git clean` of the folder removes.
 */
function expectRefusedBeforeStaging({ staged, errors }, status) {
  expect(status).toBe(1);
  expect(staged()).toEqual([]);
  expect(errors()).toContain("`git restore --staged --worktree -- :/`");
  expect(errors()).toContain("`git clean -fd -- packages/website/src/assets/settings-window/`");
}

describe("the restore commands", () => {
  it("are the literals the failures name", () => {
    expect(RESTORE_COMMAND).toBe("git restore --staged --worktree -- :/");
    expect(cleanCommand(FOLDER_REL)).toBe("git clean -fd -- packages/website/src/assets/settings-window/");
  });
});

describe("releaseCapture on a stable version", () => {
  it("runs the steps in order and stages the folder", async () => {
    const f = fakes();

    const status = await releaseCapture(VERSION, f.deps);

    expect(f.errors()).toBe("");
    expect(status).toBe(0);
    expect(f.trace).toEqual(STEPS);
    expect(f.logs()).toContain(`Staged ${FOLDER_REL}/: ${SETTINGS_WINDOW_TABS.length} screenshots at v${VERSION}`);
  });

  it("hands the runner the committed folder, the version to expect and this root", async () => {
    const f = fakes();

    await releaseCapture(VERSION, f.deps);

    expect(f.deps.runCapture).toHaveBeenCalledTimes(1);
    const [options] = f.deps.runCapture.mock.calls[0];
    expect(options.outDir).toBe(FOLDER);
    expect(options.expectVersion).toBe(VERSION);
    expect(options.repoRoot).toBe(ROOT);
    expect(options.log).toBe(f.deps.log);
    expect(options.warn).toBe(f.deps.warn);
  });

  it("builds in the root and checks the built plugin's config", async () => {
    const f = fakes();

    await releaseCapture(VERSION, f.deps);

    expect(f.deps.build).toHaveBeenCalledWith(ROOT);
    expect(f.deps.assertReleaseBuild).toHaveBeenCalledWith(path.join(ROOT, PLUGIN_CONFIG_REL));
  });

  it("writes capture.json as the manifest of the captured PNGs, serialised as committed", async () => {
    const f = fakes();

    await releaseCapture(VERSION, f.deps);

    const written = f.files[`${FOLDER_REL}/${CAPTURE_MANIFEST_FILE}`];
    const manifest = JSON.parse(written);
    expect(manifest.version).toBe(VERSION);
    expect(Object.keys(manifest.files)).toEqual(SETTINGS_WINDOW_TABS.map((tab) => tab.file).sort());
    for (const { file } of SETTINGS_WINDOW_TABS) {
      expect(manifest.files[file]).toBe(sha256Hex(encode(`png:${file}@${VERSION}`)));
    }
    expect(written).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("lets before:bump's own changes through: the version files, the fold, the fragment removal, a sealed record", async () => {
    const f = fakes();

    expect(await releaseCapture(VERSION, f.deps)).toBe(0);
    expect(f.staged()).toEqual([`stage:${FOLDER_REL}`]);
  });
});

describe("releaseCapture on a pre-release", () => {
  it.each(["3.9.0-rc.1", "3.9.0-dev.0", "3.9.0-alpha.0"])("does nothing for %s but say so", async (version) => {
    const f = fakes();

    const status = await releaseCapture(version, f.deps);

    expect(status).toBe(0);
    expect(f.trace).toEqual([]);
    expect(f.deps.fs.existsSync).not.toHaveBeenCalled();
    expect(f.deps.git).not.toHaveBeenCalled();
    expect(f.logs()).toContain(`${version} is a pre-release`);
    expect(f.errors()).toBe("");
  });

  it("refuses a version that is not semver", async () => {
    const f = fakes();

    expect(await releaseCapture("next", f.deps)).toBe(1);
    expect(f.trace).toEqual([]);
    expect(f.errors()).toContain('"next" is not a semver version');
  });
});

describe("the developer-tree refusal", () => {
  it.each([
    [FEATURE_FLAGS_LOCAL_FILE, { files: { [FEATURE_FLAGS_LOCAL_FILE]: "{}" } }, "Remove it"],
    [DEV_LOCAL_FILE, { files: { [DEV_LOCAL_FILE]: '{"voicePacksRoot":false}' } }, "Remove it"],
    [`${DEV_VOICES_ENV}=1`, { env: { [DEV_VOICES_ENV]: "1" } }, "Unset it"],
    [`${DEV_VOICES_ENV}=0`, { env: { [DEV_VOICES_ENV]: "0" } }, "Unset it"],
  ])("refuses %s before anything is built", async (marker, setup, remedy) => {
    const f = fakes(setup);

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.deps.build).not.toHaveBeenCalled();
    expect(f.deps.git).not.toHaveBeenCalled();
    expect(f.deps.runCapture).not.toHaveBeenCalled();
    expect(f.errors()).toContain("Refusing to release from a developer tree");
    expect(f.errors()).toContain(marker.split("=")[0]);
    expect(f.errors()).toContain(remedy);
  });

  it("names every marker present at once", () => {
    const fs = { existsSync: () => true };
    const markers = developerTreeMarkers(ROOT, { fs, env: { [DEV_VOICES_ENV]: "1" } });

    expect(markers).toHaveLength(3);
  });

  it("finds none in a clean tree with an empty variable", () => {
    const fs = { existsSync: () => false };

    expect(developerTreeMarkers(ROOT, { fs, env: { [DEV_VOICES_ENV]: "" } })).toEqual([]);
    expect(developerTreeMarkers(ROOT, { fs, env: {} })).toEqual([]);
  });
});

describe("a failure at each step stops before staging and names the restore", () => {
  it("a build that exits non-zero, with the LNK1318 remedy", async () => {
    const f = fakes({ build: () => 3 });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.trace).toEqual(STEPS.slice(0, 4));
    expect(f.errors()).toContain("the plugin build exited 3");
    expect(f.errors()).toContain("LNK1318");
    expect(f.errors()).toContain("restore and run the release again");
  });

  it("a failed build's output tail, repeated on error ahead of the failure, with the verbose rerun", async () => {
    const tail = [
      "@iracedeck/settings:build: src/settings.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      " ERROR  run failed: command  exited (2)",
    ];
    const f = fakes({ build: () => ({ status: 2, outputTail: tail }) });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    const lines = f.deps.error.mock.calls.map(([line]) => line);
    const stopped = lines.findIndex((line) => line.startsWith("The release stopped: the plugin build exited 2"));
    expect(lines.slice(0, stopped)).toEqual([`The last 2 lines of the plugin build's output:`, ...tail, ""]);
    expect(lines[stopped]).toContain("The end of its output is above.");
    expect(lines[stopped]).toContain("`pnpm release -- -V`");
  });

  it("a failed build that printed nothing does not point above", async () => {
    const f = fakes({ build: () => 1 });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("the plugin build exited 1, so there is nothing to capture. It printed nothing.");
    expect(f.errors()).not.toContain("above");
    expect(f.errors()).not.toContain("output:");
    expect(f.errors()).toContain("`pnpm release -- -V`");
  });

  it("a built bin/config.json carrying devVoicePacksRoot, before the capture", async () => {
    const f = fakes({
      files: { [PLUGIN_CONFIG_REL]: '{"devVoicePacksRoot":"C:/dev/voices"}\n' },
      assertReleaseBuild: (configPath) => {
        // The real check over the fake tree, so the refusal is its own.
        const { fs, log, error } = f.deps;

        return realAssertReleaseBuild(configPath, { fs, log: { log, error } });
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.trace).toEqual(STEPS.slice(0, 5));
    expect(f.deps.runCapture).not.toHaveBeenCalled();
    expect(f.errors()).toContain("carries devVoicePacksRoot");
    expect(f.errors()).toContain(`${PLUGIN_CONFIG_REL} is not a release build`);
  });

  it("a capture that cannot start (no build, no browser)", async () => {
    const f = fakes({
      capture: async () => {
        throw new CapturePreconditionError("No Chromium-based browser (Edge or Chrome) was found on this machine.");
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.trace).toEqual(STEPS.slice(0, 6));
    expect(f.errors()).toContain("No Chromium-based browser");
    expect(f.deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("a page whose header shows another version", async () => {
    const f = fakes({
      capture: async () => {
        throw new Error(
          'The settings page should show v3.9.0, but its header says "v3.9.0-dev.0". No screenshot was written.',
        );
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("The settings page should show v3.9.0");
    expect(f.deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("a Support tab skipped for its image, naming the tab and the reason", async () => {
    const f = fakes({
      capture: async (options, { files }) => {
        const written = [];
        for (const { file } of SETTINGS_WINDOW_TABS) {
          if (file === "support.png") continue;
          files[`${FOLDER_REL}/${file}`] = `png:${file}@${VERSION}`;
          written.push(path.join(options.outDir, file));
        }

        return {
          written,
          skipped: [
            {
              file: path.join(options.outDir, "support.png"),
              label: "Support iRaceDeck",
              reason: "an image failed to load",
            },
          ],
        };
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("1 Settings window tab was not captured");
    expect(f.errors()).toContain("support.png (the Support iRaceDeck tab): an image failed to load");
    expect(f.errors()).toContain("once the network is back");
    expect(f.deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("a stray PNG of a tab the list does not name, after the manifest is written without it", async () => {
    const f = fakes({ files: { [`${FOLDER_REL}/old-tab.png`]: "png:old" } });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.trace).toEqual(STEPS.slice(0, 7));
    expect(f.errors()).toContain(`does not pass its ${CAPTURE_MANIFEST_FILE} check`);
    expect(f.errors()).toContain("old-tab.png: old-tab.png has a PNG but names no tab");
    const manifest = JSON.parse(f.files[`${FOLDER_REL}/${CAPTURE_MANIFEST_FILE}`]);
    expect(manifest.files).not.toHaveProperty("old-tab.png");
  });

  it("a file in the folder that is neither a PNG nor the manifest", async () => {
    const f = fakes({ files: { [`${FOLDER_REL}/Thumbs.db`]: "junk" } });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("holds Thumbs.db");
    expect(f.deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("a changelog with no dated section", async () => {
    const f = fakes({ files: { [CHANGELOG_SOURCE_PATH]: "---\ntitle: Changelog\n---\n\nNothing yet.\n" } });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("has no dated section");
  });

  it("a tracked file the build changed, while before:bump's changes pass", async () => {
    const f = fakes({
      build: (root, { files }) => {
        files["packages/foo/generated.json"] = "regenerated by the build\n";

        return 0;
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.trace).toEqual(STEPS.slice(0, 8));
    expect(f.errors()).toContain(`changed tracked files outside ${FOLDER_REL}/`);
    expect(f.errors()).toContain("packages/foo/generated.json (changed by the build");
    // before:bump's own changes are not in the complaint.
    expect(f.errors()).not.toContain("package.json (");
    expect(f.errors()).not.toContain("changelog");
  });

  it("a file before:bump changed that the build changed again", async () => {
    const f = fakes({
      build: (root, { files }) => {
        files["package.json"] = '{"version":"3.9.0","rewritten":true}\n';

        return 0;
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("package.json (changed again by the build after before:bump changed it)");
  });

  it("a before:bump change the build undid", async () => {
    const f = fakes({
      build: (root, { files, head }) => {
        files["packages/demo/package.json"] = head["packages/demo/package.json"];

        return 0;
      },
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("packages/demo/package.json (before:bump's change to it was undone by the build)");
  });

  it("an unexpected throw from a collaborator", async () => {
    const f = fakes();
    f.deps.git = vi.fn(() => {
      throw new Error("fatal: not a git repository");
    });

    const status = await releaseCapture(VERSION, f.deps);

    expectRefusedBeforeStaging(f, status);
    expect(f.errors()).toContain("unexpected error");
    expect(f.errors()).toContain("fatal: not a git repository");
  });
});

describe("unexpectedTrackedChanges", () => {
  it("ignores the screenshot folder in both directions and reports the rest with a reason", () => {
    const before = new Map([
      ["package.json", "a"],
      ["changelog.d/x.md", "deleted"],
      ["kept.json", "k"],
    ]);
    const after = new Map([
      ["package.json", "b"],
      ["changelog.d/x.md", "deleted"],
      [`${FOLDER_REL}/general.png`, "p"],
      [`${FOLDER_REL}/capture.json`, "m"],
      ["new.json", "n"],
    ]);

    expect(unexpectedTrackedChanges(before, after, FOLDER_REL)).toEqual([
      "package.json (changed again by the build after before:bump changed it)",
      "new.json (changed by the build; it matched HEAD when the hook started)",
      "kept.json (before:bump's change to it was undone by the build)",
    ]);
  });

  it("is empty when only the folder changed", () => {
    const before = new Map([["package.json", "a"]]);
    const after = new Map([
      ["package.json", "a"],
      [`${FOLDER_REL}/general.png`, "p"],
    ]);

    expect(unexpectedTrackedChanges(before, after, FOLDER_REL)).toEqual([]);
  });
});

describe("the dry run (RELEASE_IT_DRY_RUN=1)", () => {
  it("makes the developer-tree checks, prints the build and the capture, and writes nothing", async () => {
    const f = fakes({ env: { RELEASE_IT_DRY_RUN: "1" } });

    const status = await releaseCapture(VERSION, f.deps);

    expect(status).toBe(0);
    expect(f.trace).toEqual(STEPS.slice(0, 2));
    expect(f.deps.git).not.toHaveBeenCalled();
    expect(f.deps.build).not.toHaveBeenCalled();
    expect(f.deps.runCapture).not.toHaveBeenCalled();
    expect(f.deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(f.logs()).toContain(describeBuildCommand());
    expect(f.logs()).toContain(`--filter=${BUILD_FILTER}`);
    expect(f.logs()).toContain(`into ${FOLDER_REL}/, expecting its header to read v${VERSION}`);
    expect(f.errors()).toBe("");
  });

  it("still refuses a developer tree, saying nothing was written rather than naming a restore", async () => {
    const f = fakes({ env: { RELEASE_IT_DRY_RUN: "1", [DEV_VOICES_ENV]: "1" } });

    const status = await releaseCapture(VERSION, f.deps);

    expect(status).toBe(1);
    expect(f.errors()).toContain("Refusing to release from a developer tree");
    expect(f.errors()).toContain("Nothing was written");
    expect(f.errors()).not.toContain(RESTORE_COMMAND);
  });

  it("is still a no-op on a pre-release", async () => {
    const f = fakes({ env: { RELEASE_IT_DRY_RUN: "1" } });

    expect(await releaseCapture("3.9.0-rc.1", f.deps)).toBe(0);
    expect(f.trace).toEqual([]);
  });
});

describe("the build command", () => {
  it("runs turbo's JS entry under this Node with the plugin filter, printing only failed tasks' logs", () => {
    const command = describeBuildCommand();

    expect(command.startsWith(process.execPath)).toBe(true);
    expect(command).toMatch(/turbo[\\/]bin[\\/]turbo/);
    expect(command.endsWith(` run build --filter=${BUILD_FILTER} --output-logs=errors-only`)).toBe(true);
  });
});

describe("createOutputTail", () => {
  it("keeps the last lines of both streams, in the order they finished", () => {
    const tail = createOutputTail(3);

    tail.write("stdout", "one\ntwo\n");
    tail.write("stderr", "three\r\n");
    tail.write("stdout", "four\nfive\n");

    expect(tail.lines()).toEqual(["three", "four", "five"]);
  });

  it("joins a line cut across chunks within its own stream, never with the other one's", () => {
    const tail = createOutputTail(10);

    tail.write("stdout", "src/a.ts(1,1): err");
    tail.write("stderr", "warning: slow\n");
    tail.write("stdout", "or TS2322\n");

    expect(tail.lines()).toEqual(["warning: slow", "src/a.ts(1,1): error TS2322"]);
  });

  it("joins a CRLF split between two chunks", () => {
    const tail = createOutputTail(10);

    tail.write("stdout", "a\r");
    tail.write("stdout", "\nb\r\n");

    expect(tail.lines()).toEqual(["a", "b"]);
  });

  it("includes each stream's unfinished last line, still bounded", () => {
    const tail = createOutputTail(2);

    tail.write("stdout", "one\ntwo\nno newline at the end");
    tail.write("stderr", "dangling\r");

    expect(tail.lines()).toEqual(["no newline at the end", "dangling"]);
  });

  it("keeps blank lines that were finished but not an empty unfinished one", () => {
    const tail = createOutputTail(10);

    tail.write("stdout", "a\n\nb\n");

    expect(tail.lines()).toEqual(["a", "", "b"]);
  });
});

describe("runTeed", () => {
  /** A writable that records what it was handed. */
  const sink = () => {
    const chunks = [];

    return { chunks, write: (text) => chunks.push(text), text: () => chunks.join("") };
  };

  it("streams both outputs live, resolves with the exit code and keeps the tail", async () => {
    const out = sink();
    const err = sink();
    const script =
      "process.stdout.write('compiling\\nsrc/a.ts: error TS2322\\n');" +
      "process.stderr.write('turbo: task failed\\n');" +
      "process.exitCode = 7;";

    const result = await runTeed(process.execPath, ["-e", script], { cwd: ROOT_CWD, out, err });

    expect(result.status).toBe(7);
    expect(out.text()).toBe("compiling\nsrc/a.ts: error TS2322\n");
    expect(err.text()).toBe("turbo: task failed\n");
    expect([...result.outputTail].sort()).toEqual(["compiling", "src/a.ts: error TS2322", "turbo: task failed"].sort());
  });

  it("keeps only the last maxLines lines of a long output, while streaming all of it", async () => {
    const out = sink();
    const script = "for (let i = 1; i <= 500; i++) process.stdout.write('line ' + i + '\\n');";

    const result = await runTeed(process.execPath, ["-e", script], { cwd: ROOT_CWD, out, err: sink(), maxLines: 200 });

    expect(result.status).toBe(0);
    expect(out.text()).toBe(Array.from({ length: 500 }, (_, i) => `line ${i + 1}\n`).join(""));
    expect(result.outputTail).toHaveLength(200);
    expect(result.outputTail[0]).toBe("line 301");
    expect(result.outputTail.at(-1)).toBe("line 500");
  });

  it("decodes a character split across two writes whole", async () => {
    const out = sink();
    // "é" is two bytes in UTF-8; write them as separate chunks.
    const script =
      "process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));" +
      "setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50);";

    const result = await runTeed(process.execPath, ["-e", script], { cwd: ROOT_CWD, out, err: sink() });

    expect(out.text()).toBe("café\n");
    expect(result.outputTail).toEqual(["café"]);
  });

  it("rejects when the program cannot be started", async () => {
    await expect(
      runTeed(path.join(ROOT_CWD, "no-such-program-1536.exe"), [], { cwd: ROOT_CWD, out: sink(), err: sink() }),
    ).rejects.toThrow(/ENOENT/);
  });
});
