import type { CalloutScript } from "@iracedeck/callout-script";
import { describe, expect, it, vi } from "vitest";

import type { VoicePackFileSystem } from "./voice-pack-scanner.js";
import { createVoicePackService, type VoicePackServiceDeps } from "./voice-pack-service.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const PLUGIN_AUDIO = "/plugin/assets/audio";
const PACKS_ROOT = "/packs";
const DEV_ROOT = "/dev";

/** A planted file the fake refuses to open — locked, permission-denied — as opposed to one that is not there. */
const UNREADABLE = Symbol("unreadable");

type PlantedFiles = Record<string, string | typeof UNREADABLE>;

function posix(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "");
}

function folderOf(dir: string): string {
  return posix(dir).split("/").at(-1) ?? "";
}

/** The root a pack folder sits under — `/dev/default` → `/dev`. */
function rootOf(packDir: string): string {
  return posix(packDir).split("/").slice(0, -1).join("/");
}

/**
 * `packs` names each pack folder and its clips; `files` plants extra files by
 * POSIX absolute path (`/packs/luca/voice-pack.json` to declare a voice whose
 * id differs from the pack's, `/packs/luca/voice/luca/callouts.json`) for the
 * reads the scan makes beyond the manifest it fabricates.
 *
 * `devPacks` is the same for the development root (#1143). It is keyed by root
 * rather than merged, so a test can put the same folder under BOTH and see
 * which copy is listed — the whole point of that root.
 */
function fakeFs(
  packs: Record<string, string[]>,
  files: PlantedFiles = {},
  devPacks: Record<string, string[]> = {},
): VoicePackFileSystem {
  const under = (root: string) => (root === DEV_ROOT ? devPacks : packs);

  return {
    listDirectories: (dir) => Object.keys(under(posix(dir))),
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
    listMp3Files: (packDir) => under(rootOf(packDir))[folderOf(packDir)] ?? [],
  };
}

/** A manifest for pack `id` declaring the given bare voice ids. */
function manifest(id: string, voices: readonly string[]): string {
  return JSON.stringify({
    schema: 1,
    id,
    label: id,
    version: "1.0.0",
    voices: voices.map((v) => ({ id: v, label: v })),
  });
}

function make(
  packs: Record<string, string[]>,
  overrides: Partial<VoicePackServiceDeps> = {},
  files: PlantedFiles = {},
  devPacks: Record<string, string[]> = {},
) {
  const applyRoots = vi.fn();
  const applyManifest = vi.fn();
  const applyScripts = vi.fn();
  const onPacksChanged = vi.fn();
  const service = createVoicePackService({
    root: PACKS_ROOT,
    fs: fakeFs(packs, files, devPacks),
    logger: logger as never,
    pluginAudioDir: PLUGIN_AUDIO,
    applyRoots,
    applyManifest,
    applyScripts,
    onPacksChanged,
    ...overrides,
  });

  return { service, applyRoots, applyManifest, applyScripts, onPacksChanged };
}

type AppliedRoot = { dir: string; clips?: readonly string[]; voices?: Readonly<Record<string, string>> };

describe("createVoicePackService", () => {
  it("puts the plugin audio dir first and each pack dir after it", () => {
    const { service, applyRoots } = make({ luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();

    expect(applyRoots).toHaveBeenCalledTimes(1);
    const roots = applyRoots.mock.calls[0][0] as AppliedRoot[];

    expect(roots[0].dir).toBe(PLUGIN_AUDIO);
    expect(roots).toHaveLength(2);
    expect(folderOf(roots[1].dir)).toBe("luca");
  });

  it("leaves the plugin root unrestricted and gives every pack root its admitted clips", () => {
    // The authorisation half of the rule. The scanner admits a pack's own
    // voices by DROPPING every other file from its clip list — the file is
    // still on that pack's disk, so a resolver going on file presence alone
    // would serve it. The allow-list is what makes dropping it mean something.
    const { service, applyRoots } = make({
      "aaa-evil": ["voice/aaa-evil/flags/a.mp3", "voice/luca/flags/blue-01.mp3"],
      luca: ["voice/luca/flags/blue-01.mp3"],
    });
    service.refresh();

    const roots = applyRoots.mock.calls[0][0] as AppliedRoot[];

    expect(roots[0].clips).toBeUndefined();
    expect(roots[0].voices).toBeUndefined();
    expect(folderOf(roots[1].dir)).toBe("aaa-evil");
    expect(roots[1].clips).toEqual(["voice/aaa-evil/flags/a.mp3"]);
    expect(roots[1].clips).not.toContain("voice/luca/flags/blue-01.mp3");
    expect(folderOf(roots[2].dir)).toBe("luca");
    expect(roots[2].clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("binds each pack root to its voices' composite ids (#1144)", () => {
    // The audio service resolves `voice/<composite>/…` only in the root bound
    // to that composite, as the bare `voice/<voice>/…` the pack's files sit
    // under. The binding is what the scan's `packVoiceId` is for.
    const { service, applyRoots } = make(
      { duo: ["voice/a/flags/a.mp3", "voice/b/flags/a.mp3"] },
      {},
      { "/packs/duo/voice-pack.json": manifest("duo", ["a", "b"]) },
    );
    service.refresh();

    const roots = applyRoots.mock.calls[0][0] as AppliedRoot[];

    expect(roots[1].voices).toEqual({ "duo::a": "a", "duo::b": "b" });
  });

  it("passes each pack's clips through as a fragment, qualified with the pack id", () => {
    // The engine's logical clip paths carry the composite id (#1144), so the
    // manifest's voice list, the `{voice}` substitution and the driver-name
    // union all see `duo::luca` — while the pack's own root keeps the bare
    // spelling its files actually have.
    const { service, applyManifest, applyRoots } = make({ luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();

    expect(applyManifest).toHaveBeenCalledWith([["voice/luca::luca/flags/a.mp3"]]);
    expect((applyRoots.mock.calls[0][0] as AppliedRoot[])[1].clips).toEqual(["voice/luca/flags/a.mp3"]);
  });

  it("gives two packs sharing a bare voice id two bindings and two fragments", () => {
    const { service, applyManifest, applyRoots } = make(
      { alpha: ["voice/matt/flags/a.mp3"], beta: ["voice/matt/flags/a.mp3"] },
      {},
      {
        "/packs/alpha/voice-pack.json": manifest("alpha", ["matt"]),
        "/packs/beta/voice-pack.json": manifest("beta", ["matt"]),
      },
    );
    service.refresh();

    const roots = applyRoots.mock.calls[0][0] as AppliedRoot[];

    expect(roots.slice(1).map((root) => root.voices)).toEqual([{ "alpha::matt": "matt" }, { "beta::matt": "matt" }]);
    expect(applyManifest).toHaveBeenCalledWith([["voice/alpha::matt/flags/a.mp3"], ["voice/beta::matt/flags/a.mp3"]]);
    expect(service.problems()).toEqual([]);
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
  const LUCA_SCRIPT_PATH = `${PACKS_ROOT}/luca/voice/luca/callouts.json`;
  const LUCA_CLIPS = { luca: ["voice/luca/flags/a.mp3"] };

  function script(scenario: string): CalloutScript {
    return { schema: 1, scenarios: { [scenario]: { sequence: [`pool:${scenario}`] } }, frames: {}, pools: {} };
  }

  const lucaScript = script("flag-blue");
  const ninaScript = script("flag-green");

  function lastApplied(applyScripts: ReturnType<typeof vi.fn>): ReadonlyMap<string, CalloutScript> {
    return applyScripts.mock.calls.at(-1)?.[0] as ReadonlyMap<string, CalloutScript>;
  }

  it("hands each installed voice's script to the engine, keyed by its composite id (#1144)", () => {
    const { service, applyScripts } = make(LUCA_CLIPS, {}, { [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) });
    service.refresh();

    expect(applyScripts).toHaveBeenCalledTimes(1);
    expect(lastApplied(applyScripts)).toEqual(new Map([["luca::luca", lucaScript]]));
  });

  it("keeps two packs' scripts for the same bare voice id apart", () => {
    const { service, applyScripts } = make(
      { alpha: ["voice/matt/flags/a.mp3"], beta: ["voice/matt/flags/a.mp3"] },
      {},
      {
        "/packs/alpha/voice-pack.json": manifest("alpha", ["matt"]),
        "/packs/beta/voice-pack.json": manifest("beta", ["matt"]),
        "/packs/alpha/voice/matt/callouts.json": JSON.stringify(lucaScript),
        "/packs/beta/voice/matt/callouts.json": JSON.stringify(ninaScript),
      },
    );
    service.refresh();

    expect(lastApplied(applyScripts)).toEqual(
      new Map([
        ["alpha::matt", lucaScript],
        ["beta::matt", ninaScript],
      ]),
    );
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

  it("returns the last applied map from scripts(), and an empty one before the first refresh", () => {
    const { service, applyScripts } = make(LUCA_CLIPS, {}, { [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) });

    expect(service.scripts()).toEqual(new Map());

    service.refresh();

    expect(service.scripts()).toBe(lastApplied(applyScripts));
    expect(service.scripts()).toEqual(new Map([["luca::luca", lucaScript]]));
  });

  it("re-reads every script on each refresh, so an edited file is what the engine gets", () => {
    const files: PlantedFiles = { [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) };
    const { service } = make(LUCA_CLIPS, {}, files);
    service.refresh();

    files[LUCA_SCRIPT_PATH] = JSON.stringify(ninaScript);
    service.refresh();

    expect(service.scripts().get("luca::luca")).toEqual(ninaScript);
  });

  it("keeps the previous map when the scan fails", () => {
    logger.error.mockClear();
    let scans = 0;
    const inner = fakeFs(LUCA_CLIPS, { [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) });
    const { service, applyScripts } = make(LUCA_CLIPS, {
      fs: {
        ...inner,
        listDirectories: (dir) => {
          if (++scans > 1) throw new Error("disk gone");

          return inner.listDirectories(dir);
        },
      },
    });
    service.refresh();
    const first = service.scripts();

    expect(first).toEqual(new Map([["luca::luca", lucaScript]]));

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
        applyManifest: () => {
          if (++refreshes > 1) throw new Error("engine exploded");
        },
      },
      { [LUCA_SCRIPT_PATH]: JSON.stringify(lucaScript) },
    );
    service.refresh();
    const scripts = service.scripts();
    const installed = service.installed();
    const problems = service.problems();

    expect(scripts).toEqual(new Map([["luca::luca", lucaScript]]));

    service.refresh();

    expect(service.scripts()).toBe(scripts);
    expect(service.installed()).toBe(installed);
    expect(service.problems()).toBe(problems);
    expect(applyScripts).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("hands over an empty map when no pack is installed", () => {
    const { service, applyScripts } = make({});
    service.refresh();

    expect(applyScripts).toHaveBeenCalledWith(new Map());
  });
});

describe("createVoicePackService and the development voice root (#1143)", () => {
  it("scans the development root ahead of the packs root, and says which packs it provides", () => {
    // The same pack id under both roots: the dev copy is listed, and the
    // AppData copy is shadowed whole with the reason that names the
    // development build — a sentence about the row the user is looking at.
    const { service } = make(
      { default: ["voice/default/flags/green-01.mp3"] },
      { devRoot: DEV_ROOT },
      {},
      { default: ["voice/default/flags/green-01.mp3"] },
    );

    const installed = service.refresh();

    expect(installed.map((pack) => pack.id)).toEqual(["default"]);
    expect(installed[0]?.provenance).toBe("development");
    expect(posix(installed[0]?.dir ?? "")).toBe(`${DEV_ROOT}/default`);
    expect(service.problems()).toEqual([
      {
        pack: "default",
        reason: 'pack "default" is provided by the development build; the copy under the packs root is ignored',
      },
    ]);
    expect(service.isProvidedByDevRoot("default")).toBe(true);
    expect(service.isProvidedByDevRoot("nina")).toBe(false);
  });

  it("answers false for a pack the packs root provides, and before any scan", () => {
    const { service } = make({ luca: ["voice/luca/flags/a.mp3"] });

    expect(service.isProvidedByDevRoot("luca")).toBe(false);

    service.refresh();

    expect(service.installed()[0]?.provenance).toBe("sideload");
    expect(service.isProvidedByDevRoot("luca")).toBe(false);
  });

  it("warns once per run when the development root is missing or empty, with the path at debug", () => {
    // A developer who staged nothing gets told why the pack they expected is
    // not there — once, not on every Rescan, and with the path (a parameter)
    // at debug per the logging rules.
    logger.warn.mockClear();
    logger.debug.mockClear();
    const { service } = make({}, { devRoot: "/nowhere" });
    service.refresh();
    service.refresh();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Voice packs: the development root is missing or empty");
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("/nowhere"));
  });

  it("says nothing about a development root when the build carries none", () => {
    logger.warn.mockClear();
    const { service } = make({ luca: ["voice/luca/flags/a.mp3"] });
    service.refresh();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  describe("a development root that is the packs folder itself (#1143)", () => {
    it("is ignored, with one warning and the path at debug", () => {
      logger.warn.mockClear();
      logger.debug.mockClear();
      const { service } = make({ luca: ["voice/luca/flags/a.mp3"] }, { devRoot: PACKS_ROOT });

      const installed = service.refresh();

      // Scanned ONCE, as the packs root. Scanning the same directory twice
      // would list every pack a second time, and the second copy would lose
      // every voice to the first — so every row would read `development`,
      // lose its Remove button and drop out of the launch step's ensure.
      expect(installed.map((pack) => pack.id)).toEqual(["luca"]);
      expect(installed[0]?.provenance).toBe("sideload");
      expect(service.problems()).toEqual([]);
      expect(service.isProvidedByDevRoot("luca")).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        "Voice packs: the development root is the packs folder itself; ignoring it",
      );
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(PACKS_ROOT));
    });

    it("warns once per run, not once per scan", () => {
      logger.warn.mockClear();
      const { service } = make({}, { devRoot: PACKS_ROOT });
      service.refresh();
      service.refresh();

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("does not also claim the root is missing or empty", () => {
      logger.warn.mockClear();
      const { service } = make({}, { devRoot: PACKS_ROOT });
      service.refresh();

      expect(logger.warn).not.toHaveBeenCalledWith("Voice packs: the development root is missing or empty");
    });

    it("compares the two paths without caring about case or a trailing separator", () => {
      logger.warn.mockClear();
      const { service } = make({}, { devRoot: `${PACKS_ROOT.toUpperCase()}/` });
      service.refresh();

      expect(logger.warn).toHaveBeenCalledWith(
        "Voice packs: the development root is the packs folder itself; ignoring it",
      );
    });
  });

  describe("a development root that yields no usable pack (#1143)", () => {
    it("warns and names the folders it could not use", () => {
      // A regenerated `callouts.json` that no longer parses: the folder is
      // there, the developer just staged it, and every voice in it is dropped.
      // The AppData copy then wins silently and the row flips back to
      // Downloaded — the one outcome that looks like the edit had no effect.
      logger.warn.mockClear();
      logger.debug.mockClear();
      const { service } = make(
        { default: ["voice/default/flags/green-01.mp3"] },
        { devRoot: DEV_ROOT },
        { "/dev/default/voice/default/callouts.json": "{ not json" },
        { default: ["voice/default/flags/green-01.mp3"] },
      );

      const installed = service.refresh();

      expect(installed.map((pack) => pack.provenance)).toEqual(["sideload"]);
      expect(logger.warn).toHaveBeenCalledWith("Voice packs: the development root provides no usable pack");
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("default"));
    });

    it("says it again on every scan — a Rescan is when the developer is looking", () => {
      logger.warn.mockClear();
      const { service } = make({}, { devRoot: DEV_ROOT }, {}, { default: [] });
      service.refresh();
      service.refresh();

      const said = logger.warn.mock.calls.filter(
        ([line]) => line === "Voice packs: the development root provides no usable pack",
      );
      expect(said).toHaveLength(2);
    });

    it("says nothing when the development root does provide a pack", () => {
      logger.warn.mockClear();
      const { service } = make({}, { devRoot: DEV_ROOT }, {}, { default: ["voice/default/flags/green-01.mp3"] });
      service.refresh();

      expect(logger.warn).not.toHaveBeenCalledWith("Voice packs: the development root provides no usable pack");
    });

    it("says nothing when the development root is empty — that has its own message", () => {
      logger.warn.mockClear();
      const { service } = make({}, { devRoot: DEV_ROOT });
      service.refresh();

      expect(logger.warn).not.toHaveBeenCalledWith("Voice packs: the development root provides no usable pack");
      expect(logger.warn).toHaveBeenCalledWith("Voice packs: the development root is missing or empty");
    });
  });
});
