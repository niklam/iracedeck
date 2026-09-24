import { silentLogger } from "@iracedeck/logger";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLAY_FILE_VERSION, replaySessionFileName, resolveReplayStoreDirectory } from "./replay-session-file.js";
import {
  _resetReplaySessionStore,
  createReplaySessionStore,
  getReplaySessionStore,
  initializeReplaySessionStore,
  isReplaySessionStoreInitialized,
  REPLAY_STORE_WRITE_DEBOUNCE_MS,
  type ReplaySessionStore,
} from "./replay-session-store.js";

// The atomic write's rename, counted and made to fail on demand: an ESM
// namespace cannot be spied on, and the settings-store test's directory-as-lock
// trick cannot count how many writes a burst produced.
const fsState = vi.hoisted(() => ({ renames: 0, failNext: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    rename: async (from: string, to: string) => {
      fsState.renames++;

      if (fsState.failNext > 0) {
        fsState.failNext--;
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }

      return actual.rename(from, to);
    },
  };
});

const SUB = 86697546;

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for the condition`);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const header = (subSessionId = SUB) => ({ subSessionId, track: "Talladega Superspeedway", series: "167" });

const lapStart = (overrides: Record<string, unknown> = {}) => ({
  sessionNum: 2,
  sessionUniqueId: 3,
  carIdx: 7,
  carNumberRaw: 2,
  userId: 123456,
  lap: 1,
  frame: 30821,
  ...overrides,
});

describe("resolveReplayStoreDirectory", () => {
  it("defaults to %LOCALAPPDATA%\\iRaceDeck\\Replay — one folder for every ecosystem", () => {
    const p = resolveReplayStoreDirectory({ env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" } });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Replay");
  });

  it("falls back to USERPROFILE, then the OS home directory, and stays absolute", () => {
    expect(resolveReplayStoreDirectory({ env: { USERPROFILE: "C:\\Users\\n" } }).replace(/\\/g, "/")).toBe(
      "C:/Users/n/AppData/Local/iRaceDeck/Replay",
    );

    const bare = resolveReplayStoreDirectory({ env: {} });

    expect(isAbsolute(bare)).toBe(true);
    expect(bare.replace(/\\/g, "/")).toBe(`${homedir().replace(/\\/g, "/")}/AppData/Local/iRaceDeck/Replay`);
  });

  it("honours IRACEDECK_REPLAY_DIR as a directory override", () => {
    expect(resolveReplayStoreDirectory({ env: { LOCALAPPDATA: "C:\\x", IRACEDECK_REPLAY_DIR: "D:\\replay" } })).toBe(
      "D:\\replay",
    );
  });

  it("names a session's file session_<SubSessionID>.json", () => {
    expect(replaySessionFileName(SUB)).toBe(`session_${SUB}.json`);
  });
});

describe("createReplaySessionStore", () => {
  let dir: string;
  let store: ReplaySessionStore;
  let filePath: string;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "ird-replay-store-")), "Replay");
    filePath = join(dir, replaySessionFileName(SUB));
    store = createReplaySessionStore({ directory: dir, logger: silentLogger, debounceMs: 10 });
    fsState.renames = 0;
    fsState.failNext = 0;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("pins the debounce the spec sized for a crossing wave", () => {
    expect(REPLAY_STORE_WRITE_DEBOUNCE_MS).toBe(2000);
  });

  describe("the envelope", () => {
    it("writes the spec's envelope, creating the folder, once a marker is added", async () => {
      vi.useFakeTimers({ now: new Date("2026-09-13T18:00:00Z"), toFake: ["Date"] });

      try {
        store.setActiveSession(header());
      } finally {
        vi.useRealTimers();
      }

      expect(store.markers.add({ frame: 110070, sessionNum: 2, sessionTimeMs: 1834500 })).toBe(true);
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({
        version: REPLAY_FILE_VERSION,
        subSessionId: SUB,
        track: "Talladega Superspeedway",
        series: "167",
        sessionStart: "2026-09-13T18:00:00.000Z",
        sections: { markers: [{ frame: 110070, sessionNum: 2, sessionTimeMs: 1834500 }] },
      });
    });

    it("writes nothing for a session that only got opened", async () => {
      store.setActiveSession(header());
      await store.flush();

      expect(existsSync(dir)).toBe(false);
    });

    it("loads an existing file, keeps its sessionStart, and refreshes the rest of the header", () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          subSessionId: SUB,
          track: "old name",
          series: "",
          sessionStart: "2026-06-24T17:00:00.000Z",
          sections: { markers: [{ frame: 5, sessionNum: 0, sessionTimeMs: 1 }] },
        }),
      );

      store.setActiveSession(header());

      expect(store.getActiveSession()).toEqual({
        subSessionId: SUB,
        path: filePath,
        track: "Talladega Superspeedway",
        series: "167",
        sessionStart: "2026-06-24T17:00:00.000Z",
      });
      expect(store.markers.list()).toEqual([{ frame: 5, sessionNum: 0, sessionTimeMs: 1 }]);
    });

    it("tolerates a UTF-8 BOM", () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        filePath,
        "\ufeff" +
          JSON.stringify({ version: 1, sections: { markers: [{ frame: 5, sessionNum: 0, sessionTimeMs: 1 }] } }),
      );

      store.setActiveSession(header());

      expect(store.markers.list()).toHaveLength(1);
    });

    it("carries a section it has no reader for through every write", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({ version: 1, sections: { future: { anything: [1, 2, 3] }, markers: [] } }),
      );

      store.setActiveSession(header());
      store.markers.add({ frame: 100, sessionNum: 1, sessionTimeMs: 0 });
      await store.flush();
      store.laps.recordLapStart(lapStart());
      await store.flush();

      const written = JSON.parse(readFileSync(filePath, "utf-8"));

      expect(written.sections.future).toEqual({ anything: [1, 2, 3] });
      expect(written.sections.markers).toHaveLength(1);
      expect(written.sections.laps.sessions).toHaveLength(1);
    });

    it("never downgrades a newer envelope version on the way through", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({ version: 7, sections: {} }));

      store.setActiveSession(header());
      store.markers.add({ frame: 100, sessionNum: 1, sessionTimeMs: 0 });
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8")).version).toBe(7);
    });

    it("moves a corrupt file aside as session_<id>.corrupt-<iso>.json and starts the session fresh", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, "{ not json");

      const fresh = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        now: () => new Date("2026-09-24T10:11:12.345Z"),
      });

      fresh.setActiveSession(header());

      expect(fresh.markers.list()).toEqual([]);
      expect(existsSync(filePath)).toBe(false);
      expect(readdirSync(dir)).toEqual([`session_${SUB}.corrupt-2026-09-24T10-11-12-345Z.json`]);
      expect(readFileSync(join(dir, `session_${SUB}.corrupt-2026-09-24T10-11-12-345Z.json`), "utf-8")).toBe(
        "{ not json",
      );

      // The fresh record then writes a valid file beside the aside.
      fresh.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await fresh.flush();
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toHaveLength(1);
    });

    it("treats a JSON value that is not a replay file as corrupt too", () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify([1, 2, 3]));

      store.setActiveSession(header());

      expect(readdirSync(dir).some((f) => f.startsWith(`session_${SUB}.corrupt-`))).toBe(true);
    });
  });

  describe("writes", () => {
    it("lands a burst of updates as ONE atomic write per debounce window", async () => {
      store.setActiveSession(header());

      for (let lap = 1; lap <= 120; lap++) {
        store.laps.recordLapStart(
          lapStart({ carIdx: lap % 60, carNumberRaw: lap % 60, lap: Math.ceil(lap / 60), frame: lap * 60 }),
        );
      }

      await waitUntil(() => existsSync(filePath));
      await store.flush();

      expect(fsState.renames).toBe(1);
      expect(readdirSync(dir)).toEqual([replaySessionFileName(SUB)]);

      const laps = JSON.parse(readFileSync(filePath, "utf-8")).sections.laps;

      expect(Object.keys(laps.sessions[0].cars)).toHaveLength(60);
    });

    it("flushSync lands a still-debounced write synchronously", () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 42, sessionNum: 1, sessionTimeMs: 0 });

      expect(existsSync(filePath)).toBe(false);
      store.flushSync();
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers[0].frame).toBe(42);
      expect(readdirSync(dir)).toEqual([replaySessionFileName(SUB)]);
    });

    it("flushSync is a no-op with nothing pending", () => {
      store.setActiveSession(header());
      store.flushSync();
      expect(existsSync(dir)).toBe(false);
    });

    it("flushes the previous session immediately when the session changes", () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 42, sessionNum: 1, sessionTimeMs: 0 });
      store.setActiveSession(header(SUB + 1));

      // Handed to the async write at once — the sync flush at exit finds it
      // as an unlanded write, not as a debounced one that a timer must fire.
      store.flushSync();
      expect(readdirSync(dir).sort()).toEqual([replaySessionFileName(SUB)]);
      expect(store.markers.list()).toEqual([]);
    });

    it("flushes immediately on disconnect", async () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 42, sessionNum: 1, sessionTimeMs: 0 });
      store.clearActiveSession();

      expect(store.getActiveSession()).toBeNull();
      await waitUntil(() => existsSync(filePath));
    });

    it("re-opening a session while its last write is still in the air loads that write, not the stale disk", async () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 42, sessionNum: 1, sessionTimeMs: 0 });
      store.clearActiveSession(); // the write is enqueued, not landed
      store.setActiveSession(header());

      expect(store.markers.list().map((m) => m.frame)).toEqual([42]);
      await store.flush();
    });

    it("keeps a failed write and retries it on the schedule; flushSync lands it at shutdown", async () => {
      const retrying = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        writeRetryDelaysMs: [20],
      });
      fsState.failNext = 1;

      retrying.setActiveSession(header());
      retrying.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });

      await waitUntil(() => fsState.renames >= 1);
      expect(existsSync(filePath)).toBe(false);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

      // The retry TIMER lands it — flush() is not the signal, it would enqueue at once.
      await waitUntil(() => existsSync(filePath));
      expect(fsState.renames).toBe(2);
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toHaveLength(1);
      await retrying.flush();
    });

    it("flushSync re-does a failed write that has not been retried yet", async () => {
      const failing = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        writeRetryDelaysMs: [60_000],
      });
      fsState.failNext = 1;

      failing.setActiveSession(header());
      failing.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await failing.flush();
      expect(existsSync(filePath)).toBe(false);

      failing.flushSync();
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toHaveLength(1);
    });
  });

  describe("the offline (SubSessionID 0) record", () => {
    it("works in memory, takes laps too, and never touches the disk", async () => {
      store.setActiveSession(header(0));

      expect(store.getActiveSession()).toMatchObject({ subSessionId: 0, path: null });
      expect(store.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 })).toBe(true);
      expect(store.laps.recordLapStart(lapStart({ subSessionId: 0 }))).toBe(true);
      expect(store.laps.findLapStart({ ...lapStart(), subSessionId: 0 })).toMatchObject({ hit: true, frame: 30821 });

      await store.flush();
      store.flushSync();
      expect(existsSync(dir)).toBe(false);
    });

    it("is dropped on disconnect", () => {
      store.setActiveSession(header(0));
      store.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 });
      store.clearActiveSession();
      store.setActiveSession(header(0));

      expect(store.markers.list()).toEqual([]);
    });

    it("is dropped when another session key appears", () => {
      store.setActiveSession(header(0));
      store.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 });
      store.setActiveSession(header());
      store.setActiveSession(header(0));

      expect(store.markers.list()).toEqual([]);
    });
  });

  describe("with no active session", () => {
    it("every markers call is inert", () => {
      expect(store.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 })).toBe(false);
      expect(store.markers.deleteNearest(1)).toBeNull();
      expect(store.markers.next(1)).toBeNull();
      expect(store.markers.previous(1)).toBeNull();
      expect(store.markers.list()).toEqual([]);
    });

    it("the lap record refuses and the lookup misses with 'no file'", () => {
      expect(store.laps.recordLapStart(lapStart())).toBe(false);
      expect(store.laps.recordLapTime({ sessionNum: 2, sessionUniqueId: 3, carIdx: 7, lap: 1, timeMs: 1 })).toBe(false);
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no file" });
    });
  });

  describe("markers through the store", () => {
    it("dedupes, deletes within the window, and walks next/previous", async () => {
      store.setActiveSession(header());

      expect(store.markers.add({ frame: 1000, sessionNum: 2, sessionTimeMs: 10 })).toBe(true);
      expect(store.markers.add({ frame: 1030, sessionNum: 2, sessionTimeMs: 10 })).toBe(false);
      expect(store.markers.add({ frame: 5000, sessionNum: 2, sessionTimeMs: 50 })).toBe(true);
      expect(store.markers.next(1000)?.frame).toBe(5000);
      expect(store.markers.previous(5000)?.frame).toBe(1000);
      expect(store.markers.deleteNearest(9000)).toBeNull();
      expect(store.markers.deleteNearest(5300)?.frame).toBe(5000);

      await store.flush();
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toEqual([
        { frame: 1000, sessionNum: 2, sessionTimeMs: 10 },
      ]);
    });
  });

  describe("laps through the store", () => {
    it("ignores an event whose subSessionId is not the active session's", () => {
      store.setActiveSession(header());

      expect(store.laps.recordLapStart(lapStart({ subSessionId: SUB + 1 }))).toBe(false);
      expect(
        store.laps.recordLapTime({
          subSessionId: SUB + 1,
          sessionNum: 2,
          sessionUniqueId: 3,
          carIdx: 7,
          lap: 1,
          timeMs: 1,
        }),
      ).toBe(false);
      expect(store.laps.findLapStart({ ...lapStart(), subSessionId: SUB + 1 })).toEqual({
        hit: false,
        reason: "no file",
      });
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no session" });
    });

    it("takes an event carrying the active subSessionId, and one carrying none", () => {
      store.setActiveSession(header());

      expect(store.laps.recordLapStart(lapStart({ subSessionId: SUB }))).toBe(true);
      expect(store.laps.recordLapStart(lapStart({ lap: 2, frame: 36305 }))).toBe(true);
      expect(store.laps.findLapStart({ ...lapStart(), subSessionId: SUB, lap: 2 })).toMatchObject({
        hit: true,
        frame: 36305,
      });
    });

    it("keeps a time that arrives before its start and pairs it when the start comes", async () => {
      store.setActiveSession(header());

      expect(store.laps.recordLapTime({ sessionNum: 2, sessionUniqueId: 3, carIdx: 7, lap: 4, timeMs: 91433 })).toBe(
        true,
      );
      await store.flush();
      expect(existsSync(filePath)).toBe(false); // nothing to write yet: a time alone is not an entry

      store.laps.recordLapStart(lapStart({ lap: 4, frame: 50000 }));
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.laps.sessions[0].cars["7"].laps).toEqual([
        { lap: 4, frame: 50000, timeMs: 91433 },
      ]);
      expect(store.laps.findLapStart({ ...lapStart(), lap: 4 })).toEqual({
        hit: true,
        frame: 50000,
        timeMs: 91433,
        matchedBy: "pair",
      });
    });

    it("drops pending times with the session they belong to", () => {
      store.setActiveSession(header());
      store.laps.recordLapTime({ sessionNum: 2, sessionUniqueId: 3, carIdx: 7, lap: 4, timeMs: 91433 });
      store.setActiveSession(header(SUB + 1));
      store.setActiveSession(header());
      store.laps.recordLapStart(lapStart({ lap: 4, frame: 50000 }));

      expect(store.laps.findLapStart({ ...lapStart(), lap: 4 })).toMatchObject({ hit: true, timeMs: null });
    });

    it("a file with no laps section keeps none until a lap is recorded", async () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections).toEqual({
        markers: [{ frame: 1, sessionNum: 0, sessionTimeMs: 0 }],
      });
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no session" });
    });

    it("markers survive a laps write and laps survive a markers write", async () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();
      store.laps.recordLapStart(lapStart());
      await store.flush();
      store.markers.add({ frame: 500, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();

      const sections = JSON.parse(readFileSync(filePath, "utf-8")).sections;

      expect(sections.markers).toHaveLength(2);
      expect(sections.laps.sessions[0].cars["7"].laps).toHaveLength(1);
    });
  });
});

describe("the singleton trio", () => {
  afterEach(() => _resetReplaySessionStore());

  it("initializes once, then is reachable everywhere", () => {
    const dir = join(tmpdir(), "ird-replay-singleton");

    expect(isReplaySessionStoreInitialized()).toBe(false);
    expect(() => getReplaySessionStore()).toThrow(/not initialized/);

    const store = initializeReplaySessionStore({ directory: dir, logger: silentLogger });

    expect(isReplaySessionStoreInitialized()).toBe(true);
    expect(getReplaySessionStore()).toBe(store);
    expect(store.directory).toBe(dir);
    expect(() => initializeReplaySessionStore({ directory: dir, logger: silentLogger })).toThrow(/already initialized/);
  });
});
