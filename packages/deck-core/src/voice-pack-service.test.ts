import type { CalloutScript } from "@iracedeck/callout-script";
import { describe, expect, it, vi } from "vitest";

import type { VoicePackFileSystem } from "./voice-pack-scanner.js";
import { createVoicePackService, type VoicePackServiceDeps } from "./voice-pack-service.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const PLUGIN_AUDIO = "/plugin/assets/audio";
const PACKS_ROOT = "/packs";

/** A planted file the fake refuses to open — locked, permission-denied — as opposed to one that is not there. */
const UNREADABLE = Symbol("unreadable");

type PlantedFiles = Record<string, string | typeof UNREADABLE>;

function folderOf(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
}

/**
 * `packs` names each pack folder and its clips; `files` plants extra files by
 * POSIX absolute path (`/plugin/assets/audio/voice/default/callouts.json`,
 * `/packs/luca/voice/luca/callouts.json`) for the reads the scan and the
 * bundled-script read make beyond the manifest.
 */
function fakeFs(packs: Record<string, string[]>, files: PlantedFiles = {}): VoicePackFileSystem {
  return {
    listDirectories: () => Object.keys(packs),
    readTextFile: (file) => {
      const path = file.replace(/\\/g, "/");
      const planted = files[path];

      if (planted === UNREADABLE) return { ok: false as const, missing: false, reason: "EBUSY" };

      if (planted !== undefined) return { ok: true as const, text: planted };

      const parts = path.split("/");

      // Otherwise only the manifest exists. The scanner also reads
      // `.install.json` and, since #1064, each voice's `voice/<id>/callouts.json`;
      // answering THOSE with a manifest would fail the script grammar and drop
      // every voice.
      if (parts.at(-1) !== "voice-pack.json") return { ok: false as const, missing: true, reason: "ENOENT" };

      const id = parts.at(-2) ?? "";

      return {
        ok: true as const,
        text: JSON.stringify({ schema: 1, id, label: id, version: "1.0.0", voices: [{ id, label: id }] }),
      };
    },
    listMp3Files: (packDir) => packs[folderOf(packDir)] ?? [],
  };
}

function make(
  packs: Record<string, string[]>,
  overrides: Partial<VoicePackServiceDeps> = {},
  files: PlantedFiles = {},
) {
  const applyRoots = vi.fn();
  const applyManifest = vi.fn();
  const applyScripts = vi.fn();
  const onPacksChanged = vi.fn();
  const service = createVoicePackService({
    root: PACKS_ROOT,
    fs: fakeFs(packs, files),
    logger: logger as never,
    pluginAudioDir: PLUGIN_AUDIO,
    reservedVoices: [],
    applyRoots,
    applyManifest,
    applyScripts,
    onPacksChanged,
    ...overrides,
  });

  return { service, applyRoots, applyManifest, applyScripts, onPacksChanged };
}

describe("createVoicePackService", () => {
  it("puts the plugin audio dir first and each pack dir after it", () => {
    const { service, applyRoots } = make({ luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();

    expect(applyRoots).toHaveBeenCalledTimes(1);
    const roots = applyRoots.mock.calls[0][0] as { dir: string; clips?: readonly string[] }[];

    expect(roots[0].dir).toBe(PLUGIN_AUDIO);
    expect(roots).toHaveLength(2);
    expect(folderOf(roots[1].dir)).toBe("luca");
  });

  it("leaves the plugin root unrestricted and gives every pack root its admitted clips", () => {
    // The authorisation half of the collision rule. The scanner enforces "one
    // voice, one owner" by DROPPING a foreign file from a pack's clip list — the
    // file is still on that pack's disk, so a resolver going on file presence
    // alone would serve it. The allow-list is what makes dropping it mean
    // something.
    const { service, applyRoots } = make({
      "aaa-evil": ["voice/aaa-evil/flags/a.mp3", "voice/luca/flags/blue-01.mp3"],
      luca: ["voice/luca/flags/blue-01.mp3"],
    });
    service.refresh();

    const roots = applyRoots.mock.calls[0][0] as { dir: string; clips?: readonly string[] }[];

    expect(roots[0].clips).toBeUndefined();
    expect(folderOf(roots[1].dir)).toBe("aaa-evil");
    expect(roots[1].clips).toEqual(["voice/aaa-evil/flags/a.mp3"]);
    expect(roots[1].clips).not.toContain("voice/luca/flags/blue-01.mp3");
    expect(folderOf(roots[2].dir)).toBe("luca");
    expect(roots[2].clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("passes each pack's clips through as a fragment", () => {
    const { service, applyManifest } = make({ luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();

    expect(applyManifest).toHaveBeenCalledWith([["voice/luca/flags/a.mp3"]]);
  });

  it("applies roots before the manifest so a clip is never advertised before it can resolve", () => {
    const order: string[] = [];
    const { service } = make(
      { luca: ["voice/luca/flags/a.mp3"] },
      {
        applyRoots: () => void order.push("roots"),
        applyManifest: () => void order.push("manifest"),
      },
    );
    service.refresh();

    expect(order).toEqual(["roots", "manifest"]);
  });

  it("still applies the plugin root when no packs are installed", () => {
    const { service, applyRoots, applyManifest, onPacksChanged } = make({});

    expect(service.refresh()).toEqual([]);
    expect(applyRoots).toHaveBeenCalledWith([{ dir: PLUGIN_AUDIO }]);
    expect(applyManifest).toHaveBeenCalledWith([]);
    expect(onPacksChanged).toHaveBeenCalledWith();
  });

  it("keeps the last scan available via installed()", () => {
    const { service } = make({ luca: ["voice/luca/flags/a.mp3"] });

    expect(service.installed()).toEqual([]);

    service.refresh();

    expect(service.installed().map((pack) => pack.id)).toEqual(["luca"]);
  });

  it("re-scans on every refresh rather than caching the first result", () => {
    const { service, applyRoots } = make({ luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();
    service.refresh();

    expect(applyRoots).toHaveBeenCalledTimes(2);
  });

  it("warns once per problem so an inert sideloaded pack explains itself", () => {
    logger.warn.mockClear();
    const { service } = make({ luca: [] });
    service.refresh();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain("luca");
  });

  it("forwards reservedVoices so a pack cannot claim a bundled voice", () => {
    const { service, applyRoots } = make({ luca: ["voice/luca/flags/a.mp3"] }, { reservedVoices: ["luca"] });

    expect(service.refresh()).toEqual([]);
    expect(applyRoots).toHaveBeenCalledWith([{ dir: PLUGIN_AUDIO }]);
  });

  it("survives a throwing apply callback rather than taking the plugin down with it", () => {
    // `refresh()` runs at module scope and on the settings window's
    // `sendToPlugin` frame; neither path catches, so a throw here would end the
    // plugin process.
    logger.error.mockClear();
    const { service, onPacksChanged } = make(
      { luca: ["voice/luca/flags/a.mp3"] },
      {
        applyManifest: () => {
          throw new Error("engine exploded");
        },
      },
    );

    expect(() => service.refresh()).not.toThrow();
    expect(onPacksChanged).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("reports problems alongside the packs that did load", () => {
    const { service } = make({ broken: [], luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();

    expect(service.installed().map((pack) => pack.id)).toEqual(["luca"]);
    expect(service.problems().map((problem) => problem.pack)).toEqual(["broken"]);
  });

  it("has no problems to report before the first scan", () => {
    const { service } = make({ broken: [] });

    expect(service.problems()).toEqual([]);
  });

  it("replaces the previous scan's problems rather than accumulating them", () => {
    // The read model describes the CURRENT state of the directory, so a problem
    // the user has since fixed must disappear from the settings list on rescan
    // — the same reason the key it feeds is run-scoped.
    const dirs: Record<string, string[]> = { broken: [], luca: ["voice/luca/flags/a.mp3"] };
    const { service } = make(dirs);

    service.refresh();

    expect(service.problems().map((problem) => problem.pack)).toEqual(["broken"]);

    delete dirs.broken;
    service.refresh();

    expect(service.problems()).toEqual([]);
  });
});

describe("createVoicePackService hands the engine every voice's callout script (#1064)", () => {
  const BUNDLED_SCRIPT_PATH = `${PLUGIN_AUDIO}/voice/default/callouts.json`;
  const LUCA_SCRIPT_PATH = `${PACKS_ROOT}/luca/voice/luca/callouts.json`;
  const LUCA_CLIPS = { luca: ["voice/luca/flags/a.mp3"] };

  function script(scenario: string): CalloutScript {
    return { schema: 1, scenarios: { [scenario]: { sequence: [`pool:${scenario}`] } }, frames: {}, pools: {} };
  }

  const bundledScript = script("flag-green");
  const lucaScript = script("flag-blue");

  function lastApplied(applyScripts: ReturnType<typeof vi.fn>): ReadonlyMap<string, CalloutScript> {
    return applyScripts.mock.calls.at(-1)?.[0] as ReadonlyMap<string, CalloutScript>;
  }

  it("reads each bundled voice's script from the plugin audio dir and hands it to the engine", () => {
    const { service, applyScripts } = make(
      {},
      { reservedVoices: ["default"] },
      { [BUNDLED_SCRIPT_PATH]: JSON.stringify(bundledScript) },
    );
    service.refresh();

    expect(applyScripts).toHaveBeenCalledTimes(1);
    expect(lastApplied(applyScripts)).toEqual(new Map([["default", bundledScript]]));
  });

  it("adds each installed voice's script after the bundled ones", () => {
    const { service, applyScripts } = make(
      LUCA_CLIPS,
      { reservedVoices: ["default"] },
      { [BUNDLED_SCRIPT_PATH]: JSON.stringify(bundledScript), [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) },
    );
    service.refresh();

    const applied = lastApplied(applyScripts);

    expect([...applied.keys()]).toEqual(["default", "luca"]);
    expect(applied.get("luca")).toEqual(lucaScript);
  });

  it("leaves a clips-only installed voice out of the map rather than mapping it to nothing", () => {
    const { service, applyScripts } = make(LUCA_CLIPS);
    service.refresh();

    expect(service.installed().map((pack) => pack.id)).toEqual(["luca"]);
    expect(lastApplied(applyScripts)).toEqual(new Map());
  });

  it("applies the scripts after the manifest and before the packs-changed notification", () => {
    // The engine compiles a script against the manifest's clip set, so the
    // clips must be known first; and the notification is what republishes the
    // read model, which must not describe scripts the engine has not been
    // handed yet.
    const order: string[] = [];
    const { service } = make(LUCA_CLIPS, {
      applyRoots: () => void order.push("roots"),
      applyManifest: () => void order.push("manifest"),
      applyScripts: () => void order.push("scripts"),
      onPacksChanged: () => void order.push("changed"),
    });
    service.refresh();

    expect(order).toEqual(["roots", "manifest", "scripts", "changed"]);
  });

  it("warns once per refresh for a bundled voice with no script, and leaves it out of the map", () => {
    // A bundled voice is ours: a missing script is a packaging bug, not a
    // pack author's choice, so it is said out loud rather than treated as a
    // clips-only voice — but said once per refresh, not once per callout.
    logger.warn.mockClear();
    const { service, applyScripts } = make({}, { reservedVoices: ["default"] });
    service.refresh();

    expect(lastApplied(applyScripts)).toEqual(new Map());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('"default"');
    expect(String(logger.warn.mock.calls[0][0])).toContain("callouts.json");

    service.refresh();

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("warns for a bundled voice whose script is malformed, naming the reason, and leaves it out", () => {
    logger.warn.mockClear();
    const { service, applyScripts } = make(
      {},
      { reservedVoices: ["default"] },
      { [BUNDLED_SCRIPT_PATH]: JSON.stringify({ schema: 2, scenarios: {}, frames: {}, pools: {} }) },
    );
    service.refresh();

    expect(lastApplied(applyScripts)).toEqual(new Map());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('"default"');
    expect(String(logger.warn.mock.calls[0][0])).toContain("schema");
  });

  it("warns for a bundled voice whose script cannot be read, with the errno", () => {
    logger.warn.mockClear();
    const { service, applyScripts } = make({}, { reservedVoices: ["default"] }, { [BUNDLED_SCRIPT_PATH]: UNREADABLE });
    service.refresh();

    expect(lastApplied(applyScripts)).toEqual(new Map());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain("EBUSY");
  });

  it("never throws for a bundled voice's script problem, and still hands the other voices over", () => {
    const { service, applyScripts, onPacksChanged } = make(
      LUCA_CLIPS,
      { reservedVoices: ["default"] },
      { [BUNDLED_SCRIPT_PATH]: "{not json", [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) },
    );

    expect(() => service.refresh()).not.toThrow();
    expect(lastApplied(applyScripts)).toEqual(new Map([["luca", lucaScript]]));
    expect(onPacksChanged).toHaveBeenCalledTimes(1);
  });

  it("returns the last applied map from scripts(), and an empty one before the first refresh", () => {
    const { service, applyScripts } = make(
      {},
      { reservedVoices: ["default"] },
      { [BUNDLED_SCRIPT_PATH]: JSON.stringify(bundledScript) },
    );

    expect(service.scripts()).toEqual(new Map());

    service.refresh();

    expect(service.scripts()).toBe(lastApplied(applyScripts));
    expect(service.scripts()).toEqual(new Map([["default", bundledScript]]));
  });

  it("re-reads every script on each refresh, so an edited file is what the engine gets", () => {
    const files: PlantedFiles = { [BUNDLED_SCRIPT_PATH]: JSON.stringify(bundledScript) };
    const { service } = make({}, { reservedVoices: ["default"] }, files);
    service.refresh();

    files[BUNDLED_SCRIPT_PATH] = JSON.stringify(lucaScript);
    service.refresh();

    expect(service.scripts().get("default")).toEqual(lucaScript);
  });

  it("keeps the previous map when the scan fails", () => {
    logger.error.mockClear();
    let scans = 0;
    const inner = fakeFs({}, { [BUNDLED_SCRIPT_PATH]: JSON.stringify(bundledScript) });
    const { service, applyScripts } = make(
      {},
      {
        reservedVoices: ["default"],
        fs: {
          ...inner,
          listDirectories: (dir) => {
            if (++scans > 1) throw new Error("disk gone");

            return inner.listDirectories(dir);
          },
        },
      },
    );
    service.refresh();
    const first = service.scripts();

    expect(first).toEqual(new Map([["default", bundledScript]]));

    service.refresh();

    expect(service.scripts()).toBe(first);
    expect(applyScripts).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("leaves scripts(), installed() and problems() at the previous scan when an apply call throws", () => {
    // The read model describes a scan the engine has been HANDED. An
    // `applyManifest` that throws means `applyScripts` never ran, so the map
    // this scan built is one the engine does not have — reporting it would
    // let the #1064 banner say the active voice is scripted while the engine
    // still runs on the previous map.
    logger.error.mockClear();
    let refreshes = 0;
    const { service, applyScripts } = make(
      LUCA_CLIPS,
      {
        reservedVoices: ["default"],
        applyManifest: () => {
          if (++refreshes > 1) throw new Error("engine exploded");
        },
      },
      { [BUNDLED_SCRIPT_PATH]: JSON.stringify(bundledScript), [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) },
    );
    service.refresh();
    const scripts = service.scripts();
    const installed = service.installed();
    const problems = service.problems();

    expect(scripts).toEqual(
      new Map([
        ["default", bundledScript],
        ["luca", lucaScript],
      ]),
    );

    service.refresh();

    expect(service.scripts()).toBe(scripts);
    expect(service.installed()).toBe(installed);
    expect(service.problems()).toBe(problems);
    expect(applyScripts).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("hands over an empty map when nothing is bundled and no pack is installed", () => {
    const { service, applyScripts } = make({});
    service.refresh();

    expect(applyScripts).toHaveBeenCalledWith(new Map());
  });
});
