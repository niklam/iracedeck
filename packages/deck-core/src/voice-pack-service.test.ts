import { describe, expect, it, vi } from "vitest";

import type { VoicePackFileSystem } from "./voice-pack-scanner.js";
import { createVoicePackService, type VoicePackServiceDeps } from "./voice-pack-service.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const PLUGIN_AUDIO = "/plugin/assets/audio";

function folderOf(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
}

function fakeFs(packs: Record<string, string[]>): VoicePackFileSystem {
  return {
    listDirectories: () => Object.keys(packs),
    readTextFile: (file) => {
      const id = file.replace(/\\/g, "/").split("/").at(-2) ?? "";

      return {
        ok: true as const,
        text: JSON.stringify({ schema: 1, id, label: id, version: "1.0.0", voices: [{ id, label: id }] }),
      };
    },
    listMp3Files: (packDir) => packs[folderOf(packDir)] ?? [],
  };
}

function make(packs: Record<string, string[]>, overrides: Partial<VoicePackServiceDeps> = {}) {
  const applyRoots = vi.fn();
  const applyManifest = vi.fn();
  const onPacksChanged = vi.fn();
  const service = createVoicePackService({
    root: "/packs",
    fs: fakeFs(packs),
    logger: logger as never,
    pluginAudioDir: PLUGIN_AUDIO,
    reservedVoices: [],
    applyRoots,
    applyManifest,
    onPacksChanged,
    ...overrides,
  });

  return { service, applyRoots, applyManifest, onPacksChanged };
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
