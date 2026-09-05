import {
  CALLOUT_SCRIPT_FILE,
  CALLOUT_SCRIPT_SCHEMA_VERSION,
  type CalloutScript,
  parseCalloutScript,
} from "@iracedeck/callout-script";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildManifest } from "../scripts/generate-audio-manifest.mjs";
import { generateCalloutScripts, main as generateCalloutScriptsMain } from "../scripts/generate-callout-scripts.mjs";
import {
  buildCalloutScript,
  CALLOUT_SCRIPTS_GENERATE_COMMAND,
  calloutScriptArtifactPath,
  serializeCalloutScript,
} from "./build/callout-scripts.mjs";
import { audioAssetsPath } from "./build/index.mjs";
import { loadVoiceConfigs, VoiceConfigSchema } from "./generate/config.ts";

const CONFIGS_DIR = path.join(audioAssetsPath, "configs");

/** A config authoring every callout-script key, in a deliberately non-alphabetical order. */
const SCRIPTED_KEYS: Pick<CalloutScript, "scenarios" | "frames" | "pools"> = {
  scenarios: {
    "pit-crew.flag-green": {
      comment: "Green flag — the race is on.",
      test: "Start a race session and take the green.",
      sequence: ["pool:flag-green", { if: "!race", then: [{ pause: 200 }, "pool:go-go-go"] }],
    },
    "pit-crew.flag-checkered": { skip: true },
  },
  frames: {
    radio: { open: ["sfx/IRD-tick-open.mp3", { ambient: "start" }], close: [{ ambient: "stop" }] },
  },
  pools: {
    "go-go-go": { group: "flags", base: "go" },
    "flag-green": { group: "flags", base: "green", comment: "the green-flag takes" },
  },
};

function voiceConfig(extra: Record<string, unknown> = {}) {
  return VoiceConfigSchema.parse({
    id: "eleven-voice-id",
    label: "Test",
    model_id: "eleven_test_model",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups: {},
    ...extra,
  });
}

describe(`voice/<voice-id>/${CALLOUT_SCRIPT_FILE}`, () => {
  const configs = loadVoiceConfigs(CONFIGS_DIR);

  it("has at least one authored voice to extract from", () => {
    expect(configs.size).toBeGreaterThan(0);
  });

  for (const [voiceId, config] of configs) {
    const artifact = calloutScriptArtifactPath(voiceId);
    const artifactRelative = path.relative(audioAssetsPath, artifact).split(path.sep).join("/");
    const source = `configs/${voiceId}.voice.json`;

    describe(`voice "${voiceId}"`, () => {
      it(`is committed and up to date with ${source}`, () => {
        expect(
          fs.existsSync(artifact),
          `${artifactRelative} is missing. Run \`${CALLOUT_SCRIPTS_GENERATE_COMMAND}\` and commit the result.`,
        ).toBe(true);

        const committed = fs.readFileSync(artifact, "utf-8");
        const expected = serializeCalloutScript(buildCalloutScript(config));

        expect(
          committed,
          `${artifactRelative} is out of date with ${source}. Run \`${CALLOUT_SCRIPTS_GENERATE_COMMAND}\` and commit the result.`,
        ).toBe(expected);
      });

      it("is a script the plugin accepts", () => {
        const result = parseCalloutScript(JSON.parse(fs.readFileSync(artifact, "utf-8")));

        expect(result.ok, result.ok ? "" : result.problems.join("\n")).toBe(true);
      });
    });
  }

  // The manifest is the list of CLIPS the plugin resolves against; the script
  // rides the voice tree beside them but is read by the voice-pack service,
  // never looked up as a clip. A json in `clips` would be a callout that
  // resolves to nothing.
  it("is never listed in manifest.json — the manifest is clips only", () => {
    const listed = buildManifest().clips.filter((clip: string) => clip.endsWith(`/${CALLOUT_SCRIPT_FILE}`));

    expect(listed).toEqual([]);
  });

  // The other direction: the loop above walks configs, so an artifact whose
  // config was deleted or renamed is never visited — it would sit in the voice
  // tree, ship with the plugin, and keep speaking a script nobody can edit.
  it("has a config for every committed artifact — an orphaned script would ship unmaintained", () => {
    const voiceRoot = path.join(audioAssetsPath, "voice");
    const orphans = fs
      .readdirSync(voiceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(calloutScriptArtifactPath(entry.name)))
      .map((entry) => entry.name)
      .filter((voiceId) => !configs.has(voiceId));

    expect(orphans, `voice/<id>/${CALLOUT_SCRIPT_FILE} with no configs/<id>.voice.json`).toEqual([]);
  });
});

describe("calloutScriptArtifactPath", () => {
  it(`is voice/<voice-id>/${CALLOUT_SCRIPT_FILE} inside the package`, () => {
    expect(calloutScriptArtifactPath("default")).toBe(
      path.join(audioAssetsPath, "voice", "default", CALLOUT_SCRIPT_FILE),
    );
  });

  it("takes another root for a tree that is not the package", () => {
    expect(calloutScriptArtifactPath("default", "/tmp/root")).toBe(
      path.join("/tmp/root", "voice", "default", CALLOUT_SCRIPT_FILE),
    );
  });
});

describe("buildCalloutScript", () => {
  it("yields empty maps under the current schema version for a config that authors none of the keys", () => {
    expect(buildCalloutScript(voiceConfig())).toEqual({
      schema: CALLOUT_SCRIPT_SCHEMA_VERSION,
      scenarios: {},
      frames: {},
      pools: {},
    });
  });

  it("copies the three maps verbatim — nothing else from the config reaches the artifact", () => {
    const script = buildCalloutScript(voiceConfig(SCRIPTED_KEYS));

    expect(script).toEqual({ schema: CALLOUT_SCRIPT_SCHEMA_VERSION, ...SCRIPTED_KEYS });
    expect(Object.keys(script)).toEqual(["schema", "scenarios", "frames", "pools"]);
  });

  it("keeps the author's key order — it is the reading order of the published reference", () => {
    const script = buildCalloutScript(voiceConfig(SCRIPTED_KEYS));

    expect(Object.keys(script.scenarios)).toEqual(["pit-crew.flag-green", "pit-crew.flag-checkered"]);
    expect(Object.keys(script.pools)).toEqual(["go-go-go", "flag-green"]);
  });

  it("does not alias the config's maps", () => {
    const config = voiceConfig(SCRIPTED_KEYS);
    const script = buildCalloutScript(config);

    expect(script.scenarios).not.toBe(config.scenarios);
    expect(script.frames).not.toBe(config.frames);
    expect(script.pools).not.toBe(config.pools);
  });

  it("yields a script parseCalloutScript accepts", () => {
    expect(parseCalloutScript(buildCalloutScript(voiceConfig(SCRIPTED_KEYS)))).toEqual({
      ok: true,
      script: { schema: CALLOUT_SCRIPT_SCHEMA_VERSION, ...SCRIPTED_KEYS },
    });
  });
});

describe("serializeCalloutScript", () => {
  it("is two-space indented JSON with a trailing newline, keys unsorted", () => {
    const script = buildCalloutScript(voiceConfig({ pools: SCRIPTED_KEYS.pools }));
    const text = serializeCalloutScript(script);

    expect(text).toBe(`${JSON.stringify(script, null, 2)}\n`);
    expect(text.indexOf('"go-go-go"')).toBeLessThan(text.indexOf('"flag-green"'));
    expect(text.endsWith("}\n")).toBe(true);
  });
});

describe("generateCalloutScripts", () => {
  const tempDirs: string[] = [];

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ird-callout-scripts-"));
    tempDirs.push(dir);

    return dir;
  }

  function writeConfig(dir: string, voiceId: string, extra: Record<string, unknown> = {}): void {
    const config = {
      id: "eleven-voice-id",
      label: voiceId,
      model_id: "eleven_test_model",
      voice_settings: { stability: 1, similarity_boost: 1 },
      groups: {},
      ...extra,
    };

    fs.writeFileSync(path.join(dir, `${voiceId}.voice.json`), JSON.stringify(config, null, 2), "utf-8");
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes one artifact per authored config, creating the voice folder when it is missing", () => {
    const configsDir = tempDir();
    const outputRoot = tempDir();
    const log: string[] = [];

    writeConfig(configsDir, "alpha", SCRIPTED_KEYS);
    writeConfig(configsDir, "beta");

    const written = generateCalloutScripts({ configsDir, outputRoot, log: (line: string) => log.push(line) });

    expect(written).toEqual([
      calloutScriptArtifactPath("alpha", outputRoot),
      calloutScriptArtifactPath("beta", outputRoot),
    ]);

    const alpha = fs.readFileSync(calloutScriptArtifactPath("alpha", outputRoot), "utf-8");
    const beta = fs.readFileSync(calloutScriptArtifactPath("beta", outputRoot), "utf-8");

    expect(alpha).toBe(serializeCalloutScript({ schema: CALLOUT_SCRIPT_SCHEMA_VERSION, ...SCRIPTED_KEYS }));
    expect(beta).toBe(
      serializeCalloutScript({ schema: CALLOUT_SCRIPT_SCHEMA_VERSION, scenarios: {}, frames: {}, pools: {} }),
    );
    expect(log.some((line) => line.includes("alpha"))).toBe(true);
  });

  it("refuses a config whose script keys are malformed, naming the file and the path", () => {
    const configsDir = tempDir();
    const outputRoot = tempDir();

    writeConfig(configsDir, "alpha", { scenarios: { "pit-crew.flag-green": { sequnce: ["pool:flag-green"] } } });

    expect(() => generateCalloutScripts({ configsDir, outputRoot, log: () => {} })).toThrow(
      /alpha\.voice\.json[\s\S]*sequnce/,
    );
    expect(fs.existsSync(calloutScriptArtifactPath("alpha", outputRoot))).toBe(false);
  });

  it("refuses an empty configs directory rather than silently writing nothing", () => {
    const configsDir = tempDir();
    const outputRoot = tempDir();

    expect(() => generateCalloutScripts({ configsDir, outputRoot, log: () => {} })).toThrow(/No voice configs/);
  });
});

describe("the CLI entry", () => {
  it("turns a failure into the message on stderr and exit code 1, never a stack trace", () => {
    const stderr: string[] = [];
    const code = generateCalloutScriptsMain({
      generate: () => {
        throw new Error("configs/alpha.voice.json: the extracted callout script is not one the plugin accepts");
      },
      error: (line: string) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stderr).toEqual(["configs/alpha.voice.json: the extracted callout script is not one the plugin accepts"]);
  });

  it("reports a non-Error throw as its string form", () => {
    const stderr: string[] = [];
    const code = generateCalloutScriptsMain({
      generate: () => {
        throw "plain string";
      },
      error: (line: string) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stderr).toEqual(["plain string"]);
  });

  it("exits 0 and writes nothing to stderr when the generator succeeds", () => {
    const stderr: string[] = [];
    const generate = vi.fn();

    expect(generateCalloutScriptsMain({ generate, error: (line: string) => stderr.push(line) })).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(stderr).toEqual([]);
  });
});
