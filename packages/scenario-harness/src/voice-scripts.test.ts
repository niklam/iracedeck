import { BUNDLED_VOICE_IDS } from "@iracedeck/audio-assets/build";
import type { AudioAssetsManifest } from "@iracedeck/audio-scenarios";
import { type CalloutScript, calloutScriptPath, parseCalloutScript } from "@iracedeck/callout-script";
import { silentLogger } from "@iracedeck/logger";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBundledVoiceScripts, loadInstalledVoiceScripts } from "./voice-scripts.js";

const VALID_SCRIPT: CalloutScript = { schema: 1, scenarios: {}, frames: {}, pools: {} };

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ird-voice-scripts-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Plant `voice/<id>/callouts.json` under `root` with the given bytes. */
function plantScript(root: string, voiceId: string, text: string): string {
  const file = join(root, calloutScriptPath(voiceId));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);

  return file;
}

describe("loadBundledVoiceScripts", () => {
  it("reads the bundled default voice's committed artifact, and it parses", () => {
    const scripts = loadBundledVoiceScripts();

    expect(BUNDLED_VOICE_IDS).toContain("default");
    expect([...scripts.keys()]).toEqual([...BUNDLED_VOICE_IDS]);

    const script = scripts.get("default");
    expect(script).toBeDefined();
    // The count is A4's / the completeness test's business; here only the shape.
    expect(parseCalloutScript(script)).toEqual({ ok: true, script });
    expect(script?.schema).toBe(1);
    expect(typeof script?.scenarios).toBe("object");
  });

  it("reads from the given root and voice list", () => {
    plantScript(tmp, "luca", JSON.stringify(VALID_SCRIPT));

    const scripts = loadBundledVoiceScripts({ root: tmp, voiceIds: ["luca"] });

    expect([...scripts.keys()]).toEqual(["luca"]);
    expect(scripts.get("luca")).toEqual(VALID_SCRIPT);
  });

  it("strips a leading BOM, as the plugin's scanner does", () => {
    plantScript(tmp, "luca", `\uFEFF${JSON.stringify(VALID_SCRIPT)}`);

    expect(loadBundledVoiceScripts({ root: tmp, voiceIds: ["luca"] }).get("luca")).toEqual(VALID_SCRIPT);
  });

  it("throws, naming the voice and the file, when the artifact is missing", () => {
    const expected = join(tmp, calloutScriptPath("luca"));

    expect(() => loadBundledVoiceScripts({ root: tmp, voiceIds: ["luca"] })).toThrow(
      new RegExp(`Bundled voice "luca" has no readable callout script at ${escapeRegExp(expected)}`),
    );
  });

  it("throws, naming the file, when the artifact is not JSON", () => {
    const file = plantScript(tmp, "luca", "{not json");

    expect(() => loadBundledVoiceScripts({ root: tmp, voiceIds: ["luca"] })).toThrow(
      new RegExp(`Bundled voice "luca": ${escapeRegExp(file)} is not valid JSON:`),
    );
  });

  it("throws, naming the file and the grammar problem, when the artifact fails the schema", () => {
    const file = plantScript(tmp, "luca", JSON.stringify({ schema: 2, scenarios: {}, frames: {}, pools: {} }));

    expect(() => loadBundledVoiceScripts({ root: tmp, voiceIds: ["luca"] })).toThrow(
      new RegExp(`Bundled voice "luca": ${escapeRegExp(file)} is not a valid callout script: schema`),
    );
  });

  it("stops at the first bad voice rather than returning a partial map", () => {
    plantScript(tmp, "luca", JSON.stringify(VALID_SCRIPT));

    expect(() => loadBundledVoiceScripts({ root: tmp, voiceIds: ["luca", "titan"] })).toThrow(/"titan"/);
  });
});

describe("loadInstalledVoiceScripts", () => {
  const bundledManifest: AudioAssetsManifest = {
    clips: ["sfx/IRD-tick-open.mp3", "voice/default/flags/green-01.mp3"],
    ambientLoop: "sfx/ambient.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };
  const bundledScripts = new Map<string, CalloutScript>([["default", VALID_SCRIPT]]);

  type Applied = {
    roots: readonly { dir: string; clips?: readonly string[] }[] | null;
    manifest: AudioAssetsManifest | null;
    scripts: ReadonlyMap<string, CalloutScript> | null;
    order: string[];
  };

  function run(
    packsRoot: string,
    pluginAudioDir: string,
  ): { applied: Applied; service: ReturnType<typeof loadInstalledVoiceScripts> } {
    const applied: Applied = { roots: null, manifest: null, scripts: null, order: [] };
    const service = loadInstalledVoiceScripts({
      root: packsRoot,
      pluginAudioDir,
      bundledManifest,
      bundledVoices: ["default"],
      bundledScripts,
      logger: silentLogger,
      applyRoots: (roots) => {
        applied.roots = roots;
        applied.order.push("roots");
      },
      applyManifest: (manifest) => {
        applied.manifest = manifest;
        applied.order.push("manifest");
      },
      applyScripts: (scripts) => {
        applied.scripts = scripts;
        applied.order.push("scripts");
      },
    });

    return { applied, service };
  }

  /** A pack folder the real scanner accepts: manifest, one clip, one script. */
  function plantPack(packsRoot: string, packId: string, voiceId: string, script: CalloutScript | null): void {
    const dir = join(packsRoot, packId);
    mkdirSync(join(dir, "voice", voiceId, "flags"), { recursive: true });
    writeFileSync(
      join(dir, "voice-pack.json"),
      JSON.stringify({
        schema: 1,
        id: packId,
        label: "Test pack",
        version: "1.0.0",
        voices: [{ id: voiceId, label: "Luca" }],
      }),
    );
    writeFileSync(join(dir, "voice", voiceId, "flags", "green-01.mp3"), "not really audio");

    if (script) writeFileSync(join(dir, "voice", voiceId, "callouts.json"), JSON.stringify(script));
  }

  it("applies roots, then the merged manifest, then bundled + installed scripts — the plugins' order", () => {
    const packsRoot = join(tmp, "packs");
    const pluginAudioDir = join(tmp, "audio");
    plantScript(pluginAudioDir, "default", JSON.stringify(VALID_SCRIPT));
    const lucaScript: CalloutScript = { ...VALID_SCRIPT, pools: { greeting: { group: "flags", base: "green" } } };
    plantPack(packsRoot, "testpack", "luca", lucaScript);

    const { applied, service } = run(packsRoot, pluginAudioDir);

    expect(applied.order).toEqual(["roots", "manifest", "scripts"]);
    expect(applied.roots?.[0]).toEqual({ dir: pluginAudioDir });
    expect(applied.roots?.[1]).toEqual({ dir: join(packsRoot, "testpack"), clips: ["voice/luca/flags/green-01.mp3"] });
    expect(applied.manifest?.clips).toEqual([...bundledManifest.clips, "voice/luca/flags/green-01.mp3"].sort());
    expect(applied.manifest?.ticks).toEqual(bundledManifest.ticks);
    expect([...(applied.scripts?.keys() ?? [])]).toEqual(["default", "luca"]);
    expect(applied.scripts?.get("luca")).toEqual(lucaScript);
    expect(service.installed().map((pack) => pack.id)).toEqual(["testpack"]);
    expect(service.problems()).toEqual([]);
  });

  it("leaves a clips-only installed voice out of the script map, keeping the bundled ones", () => {
    const packsRoot = join(tmp, "packs");
    const pluginAudioDir = join(tmp, "audio");
    plantScript(pluginAudioDir, "default", JSON.stringify(VALID_SCRIPT));
    plantPack(packsRoot, "testpack", "luca", null);

    const { applied } = run(packsRoot, pluginAudioDir);

    expect([...(applied.scripts?.keys() ?? [])]).toEqual(["default"]);
    expect(applied.manifest?.clips).toContain("voice/luca/flags/green-01.mp3");
  });

  it("falls back to the bundled scripts when the processed root has no script copy yet", () => {
    const packsRoot = join(tmp, "packs");
    const pluginAudioDir = join(tmp, "audio");
    mkdirSync(pluginAudioDir, { recursive: true });
    plantPack(packsRoot, "testpack", "luca", VALID_SCRIPT);

    const { applied } = run(packsRoot, pluginAudioDir);

    expect(applied.scripts?.get("default")).toEqual(VALID_SCRIPT);
    expect(applied.scripts?.has("luca")).toBe(true);
  });

  it("is a no-pack scan for a directory that does not exist: bundled manifest, bundled scripts, no throw", () => {
    const pluginAudioDir = join(tmp, "audio");
    plantScript(pluginAudioDir, "default", JSON.stringify(VALID_SCRIPT));

    const { applied, service } = run(join(tmp, "does-not-exist"), pluginAudioDir);

    expect(applied.roots).toEqual([{ dir: pluginAudioDir }]);
    expect(applied.manifest).toBe(bundledManifest);
    expect([...(applied.scripts?.keys() ?? [])]).toEqual(["default"]);
    expect(service.installed()).toEqual([]);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
