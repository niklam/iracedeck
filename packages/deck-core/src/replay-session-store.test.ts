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
  REPLAY_STORE_WRITE_MAX_WAIT_MS,
  type ReplaySessionStore,
} from "./replay-session-store.js";

// The atomic write's rename, counted and made to fail on demand: an ESM
// namespace cannot be spied on, and the settings-store test's directory-as-lock
// trick cannot count how many writes a burst produced. `handedOff` counts the
// writes the store STARTED (its first step is the folder's mkdir), which is the
// timing the debounce tests measure under fake timers, where the real I/O
// behind it cannot be awaited.
const fsState = vi.hoisted(() => ({ renames: 0, failNext: 0, handedOff: 0, landed: 0 }));

// The synchronous side: the load's read, the corrupt-aside rename/copy/unlink
// and the shutdown flush's rename, each counted and made to fail on demand.
const syncFs = vi.hoisted(() => ({ renames: 0, failRename: 0, failRead: 0, failCopy: 0, failUnlink: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

  return {
    ...actual,
    readFileSync: (path: string, options?: "utf-8") => {
      if (syncFs.failRead > 0) {
        syncFs.failRead--;
        throw fail("EBUSY");
      }

      return options === undefined ? actual.readFileSync(path) : actual.readFileSync(path, options);
    },
    unlinkSync: (path: string) => {
      if (syncFs.failUnlink > 0) {
        syncFs.failUnlink--;
        throw fail("EPERM");
      }

      return actual.unlinkSync(path);
    },
    renameSync: (from: string, to: string) => {
      syncFs.renames++;

      if (syncFs.failRename > 0) {
        syncFs.failRename--;
        throw fail("EPERM");
      }

      return actual.renameSync(from, to);
    },
    copyFileSync: (from: string, to: string) => {
      if (syncFs.failCopy > 0) {
        syncFs.failCopy--;
        throw fail("EPERM");
      }

      return actual.copyFileSync(from, to);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    mkdir: async (path: string, options: { recursive: boolean }) => {
      fsState.handedOff++;

      return actual.mkdir(path, options);
    },
    rename: async (from: string, to: string) => {
      fsState.renames++;

      if (fsState.failNext > 0) {
        fsState.failNext--;
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }

      await actual.rename(from, to);
      fsState.landed++;
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
  it("defaults to %LOCALAPPDATA%\\iRaceDeck\\Replay\\<ecosystem> — per ecosystem, like the settings file", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" };

    expect(resolveReplayStoreDirectory({ platform: "stream-deck", env }).replace(/\\/g, "/")).toBe(
      "C:/Users/n/AppData/Local/iRaceDeck/Replay/Stream Deck",
    );
    expect(resolveReplayStoreDirectory({ platform: "mirabox", env }).replace(/\\/g, "/")).toBe(
      "C:/Users/n/AppData/Local/iRaceDeck/Replay/Mirabox",
    );
    expect(resolveReplayStoreDirectory({ platform: "ulanzi", env }).replace(/\\/g, "/")).toBe(
      "C:/Users/n/AppData/Local/iRaceDeck/Replay/Ulanzi",
    );
  });

  it("falls back to USERPROFILE, then the OS home directory, and stays absolute", () => {
    expect(
      resolveReplayStoreDirectory({ platform: "mirabox", env: { USERPROFILE: "C:\\Users\\n" } }).replace(/\\/g, "/"),
    ).toBe("C:/Users/n/AppData/Local/iRaceDeck/Replay/Mirabox");

    const bare = resolveReplayStoreDirectory({ platform: "mirabox", env: {} });

    expect(isAbsolute(bare)).toBe(true);
    expect(bare.replace(/\\/g, "/")).toBe(`${homedir().replace(/\\/g, "/")}/AppData/Local/iRaceDeck/Replay/Mirabox`);
  });

  it("IRACEDECK_REPLAY_DIR replaces the Replay base; the ecosystem folder is still appended so two hosts stay apart", () => {
    expect(
      resolveReplayStoreDirectory({
        platform: "ulanzi",
        env: { LOCALAPPDATA: "C:\\x", IRACEDECK_REPLAY_DIR: "D:\\replay" },
      }).replace(/\\/g, "/"),
    ).toBe("D:/replay/Ulanzi");
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
    fsState.handedOff = 0;
    fsState.landed = 0;
    syncFs.renames = 0;
    syncFs.failRename = 0;
    syncFs.failRead = 0;
    syncFs.failCopy = 0;
    syncFs.failUnlink = 0;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("pins the debounce the spec sized for a crossing wave, and the max wait behind it", () => {
    expect(REPLAY_STORE_WRITE_DEBOUNCE_MS).toBe(2000);
    expect(REPLAY_STORE_WRITE_MAX_WAIT_MS).toBe(10_000);
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

    it("a failed write's retry never overwrites a newer write for the same file that landed meanwhile", async () => {
      const retrying = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        writeRetryDelaysMs: [30],
      });
      fsState.failNext = 1;

      retrying.setActiveSession(header());
      retrying.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await waitUntil(() => fsState.renames === 1); // A: refused
      expect(existsSync(filePath)).toBe(false);

      retrying.markers.add({ frame: 5000, sessionNum: 0, sessionTimeMs: 0 });
      await waitUntil(() => existsSync(filePath)); // B: landed, carrying both markers
      expect(fsState.renames).toBe(2);

      // Past A's retry delay: A's payload is stale and must not come back.
      await new Promise((resolve) => setTimeout(resolve, 80));
      await retrying.flush();

      expect(fsState.renames).toBe(2);
      expect(
        JSON.parse(readFileSync(filePath, "utf-8")).sections.markers.map((m: { frame: number }) => m.frame),
      ).toEqual([1, 5000]);
    });

    it("retries a failed write for each session on its own — one session's failure does not drop another's", async () => {
      const retrying = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        writeRetryDelaysMs: [30],
      });
      const otherPath = join(dir, replaySessionFileName(SUB + 1));

      fsState.failNext = 2;
      retrying.setActiveSession(header());
      retrying.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      retrying.setActiveSession(header(SUB + 1)); // A's write goes out now and is refused
      retrying.markers.add({ frame: 2, sessionNum: 0, sessionTimeMs: 0 }); // B's is refused after its debounce
      await waitUntil(() => fsState.renames === 2);

      await waitUntil(() => existsSync(filePath) && existsSync(otherPath));
      await retrying.flush();

      expect(fsState.renames).toBe(4);
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers[0].frame).toBe(1);
      expect(JSON.parse(readFileSync(otherPath, "utf-8")).sections.markers[0].frame).toBe(2);
    });

    it("hands a change to the disk no later than the max wait after the first unsaved one, however busy the field", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const busy = createReplaySessionStore({ directory: dir, logger: silentLogger, debounceMs: 100, maxWaitMs: 300 });

      try {
        busy.setActiveSession(header());

        let lap = 0;
        const crossing = async (): Promise<void> => {
          lap++;
          busy.laps.recordLapStart(lapStart({ carIdx: lap % 60, carNumberRaw: lap % 60, lap: 1, frame: lap * 30 }));
          await vi.advanceTimersByTimeAsync(50);
        };
        // Writes are chained, so the next can only start once the real I/O of
        // the last has landed; setImmediate is not faked and lets it.
        const landed = async (writes: number): Promise<void> => {
          while (fsState.landed < writes) await new Promise((resolve) => setImmediate(resolve));
        };

        // A crossing every 50 ms never lets a 100 ms debounce go idle …
        for (let i = 0; i < 5; i++) await crossing();

        expect(fsState.handedOff).toBe(0); // t = 250 ms

        await crossing(); // t = 300 ms: the max wait from the first change at t = 0
        expect(fsState.handedOff).toBe(1);
        await landed(1);

        // … and the next window counts from the first change after that write.
        for (let i = 0; i < 5; i++) await crossing();

        expect(fsState.handedOff).toBe(1); // t = 550 ms: the window opened at t = 300
        await crossing();
        expect(fsState.handedOff).toBe(2); // t = 600 ms
        await landed(2);

        // Left alone, the trailing debounce lands the rest.
        await crossing();
        await vi.advanceTimersByTimeAsync(100); // t = 750 ms: the debounce fired at 700
        expect(fsState.handedOff).toBe(3);
      } finally {
        vi.useRealTimers();
      }

      await busy.flush();
      expect(Object.keys(JSON.parse(readFileSync(filePath, "utf-8")).sections.laps.sessions[0].cars)).toHaveLength(13);
    });

    it("writes compact JSON — one line, newline-terminated — because a race's record reaches megabytes", async () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 42, sessionNum: 1, sessionTimeMs: 0 });
      store.laps.recordLapStart(lapStart());
      await store.flush();

      const text = readFileSync(filePath, "utf-8");

      expect(text.endsWith("\n")).toBe(true);
      expect(text.split("\n")).toHaveLength(2);
      expect(text).not.toContain("  ");
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

  describe("fail closed: a file the store cannot take responsibility for is never written over", () => {
    const lockedFile = () =>
      JSON.stringify({
        version: 1,
        sections: {
          markers: [{ frame: 5, sessionNum: 0, sessionTimeMs: 1 }],
          laps: {
            version: 1,
            sessions: [
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                cars: { "7": { carNumberRaw: 2, userId: 123456, laps: [{ lap: 1, frame: 30821, timeMs: null }] } },
              },
            ],
          },
        },
      });

    it("a file that stays unreadable (EBUSY, not ENOENT) opens a memory-only record and no write ever touches it", async () => {
      mkdirSync(dir, { recursive: true });
      const original = lockedFile();

      writeFileSync(filePath, original);
      syncFs.failRead = 100; // every read, including the retries on the way out

      store.setActiveSession(header());

      expect(store.getActiveSession()).toMatchObject({ subSessionId: SUB, path: null });
      expect(store.markers.list()).toEqual([]); // the bytes were never read
      expect(store.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 })).toBe(true);
      expect(store.laps.recordLapStart(lapStart())).toBe(true);

      await store.flush();
      store.flushSync();
      store.clearActiveSession();
      await store.flush();

      syncFs.failRead = 0;
      expect(readFileSync(filePath, "utf-8")).toBe(original);
      expect(fsState.renames).toBe(0);
      expect(syncFs.renames).toBe(0);
    });

    it("a file locked at open is re-read on the retry schedule; once readable, the record is merged into it and written", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, lockedFile());
      const retrying = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        loadRetryDelaysMs: [20],
      });

      syncFs.failRead = 1;
      retrying.setActiveSession(header());
      expect(retrying.getActiveSession()).toMatchObject({ path: null });
      expect(retrying.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no file" });

      // Recorded while the file was locked.
      expect(retrying.markers.add({ frame: 30, sessionNum: 0, sessionTimeMs: 0 })).toBe(true); // within 60 of the file's 5
      expect(retrying.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 })).toBe(true);
      retrying.laps.recordLapStart(lapStart({ lap: 1, frame: 99999 })); // the file has lap 1 at 30821
      retrying.laps.recordLapStart(lapStart({ lap: 2, frame: 36305 }));
      retrying.laps.recordLapTime({ sessionNum: 2, sessionUniqueId: 3, carIdx: 7, lap: 1, timeMs: 91433 });

      await waitUntil(() => retrying.getActiveSession()?.path !== null);
      await waitUntil(() => fsState.renames === 1);
      await retrying.flush();

      // Union: the file's marker at 5 stays and dedupes the 30; the file's lap 1 frame stays and takes the time.
      expect(retrying.markers.list().map((m) => m.frame)).toEqual([5, 100]);
      expect(retrying.laps.findLapStart(lapStart())).toEqual({
        hit: true,
        frame: 30821,
        timeMs: 91433,
        matchedBy: "pair",
      });

      const { sections } = JSON.parse(readFileSync(filePath, "utf-8"));

      expect(sections.markers.map((m: { frame: number }) => m.frame)).toEqual([5, 100]);
      expect(sections.laps.sessions[0].cars["7"].laps).toEqual([
        { lap: 1, frame: 30821, timeMs: 91433 },
        { lap: 2, frame: 36305, timeMs: null },
      ]);
    });

    it("past the retry schedule the record stays in memory, and a later setActiveSession for the same id tries the read again", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, lockedFile());
      const retrying = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        debounceMs: 10,
        loadRetryDelaysMs: [10, 10],
      });

      syncFs.failRead = 3; // the open and both retries
      retrying.setActiveSession(header());
      retrying.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 });

      await waitUntil(() => syncFs.failRead === 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(retrying.getActiveSession()).toMatchObject({ path: null });
      expect(fsState.renames).toBe(0);

      retrying.setActiveSession(header());
      expect(retrying.getActiveSession()).toMatchObject({ path: filePath });
      expect(retrying.markers.list().map((m) => m.frame)).toEqual([5, 100]);

      await retrying.flush();
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toHaveLength(2);
    });

    it("a locked corrupt file that can only be copied aside is preserved once, not once per open", () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, "{ not json");
      syncFs.failRename = 2;
      syncFs.failUnlink = 2;

      // A clock that moves between the opens, so the asides would get different names.
      let seconds = 0;
      const ticking = createReplaySessionStore({
        directory: dir,
        logger: silentLogger,
        now: () => new Date(Date.UTC(2026, 8, 24, 10, 11, seconds++)),
      });

      ticking.setActiveSession(header());
      ticking.setActiveSession(header(SUB + 1));
      ticking.setActiveSession(header());

      const asides = readdirSync(dir).filter((f) => f.startsWith(`session_${SUB}.corrupt-`));

      expect(asides).toHaveLength(1);
      expect(readFileSync(filePath, "utf-8")).toBe("{ not json");
    });

    it("a corrupt file that can be neither moved nor copied aside opens a memory-only record and stays where it is", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, "{ not json");
      syncFs.failRename = 1;
      syncFs.failCopy = 1;

      store.setActiveSession(header());

      expect(store.getActiveSession()).toMatchObject({ subSessionId: SUB, path: null });
      expect(store.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 })).toBe(true);

      await store.flush();
      store.flushSync();
      store.clearActiveSession();
      await store.flush();

      expect(readFileSync(filePath, "utf-8")).toBe("{ not json");
      expect(readdirSync(dir)).toEqual([replaySessionFileName(SUB)]);
    });

    it("a corrupt file whose rename fails but whose copy succeeds is preserved, and the fresh record may be written", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, "{ not json");
      syncFs.failRename = 1;

      store.setActiveSession(header());
      store.markers.add({ frame: 100, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();

      const names = readdirSync(dir).sort();

      expect(names).toHaveLength(2);
      expect(names.some((f) => f.startsWith(`session_${SUB}.corrupt-`))).toBe(true);
      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toHaveLength(1);
    });
  });

  describe("the shutdown flush and the temp files", () => {
    it("flushSync goes through a temp file and a rename — a refused rename leaves no file and no temp file", () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 42, sessionNum: 1, sessionTimeMs: 0 });
      syncFs.failRename = 1;

      store.flushSync();

      expect(syncFs.renames).toBe(1);
      expect(existsSync(filePath)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("removes stale temp files of its own naming on init, and nothing else", () => {
      mkdirSync(dir, { recursive: true });
      const stale = [`session_${SUB}.json.12345.tmp`, `session_${SUB}.json.12345.sync.tmp`, "session_7.json.1.tmp"];
      const kept = [
        replaySessionFileName(SUB),
        `session_${SUB}.corrupt-2026-09-24T10-11-12-345Z.json`,
        "session_x.json.1.tmp",
        "notes.tmp",
        `session_${SUB}.json.tmp`,
      ];

      for (const name of [...stale, ...kept]) writeFileSync(join(dir, name), "x");

      createReplaySessionStore({ directory: dir, logger: silentLogger });

      expect(readdirSync(dir).sort()).toEqual([...kept].sort());
    });

    it("tolerates a missing folder on init", () => {
      expect(() => createReplaySessionStore({ directory: join(dir, "nope"), logger: silentLogger })).not.toThrow();
    });
  });

  describe("forward compatibility: what this build does not read survives its writes", () => {
    it("carries an unknown envelope field (the spec's future frameBase) through a write", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({ version: 1, frameBase: 12000, sections: {} }));

      store.setActiveSession(header());
      store.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8")).frameBase).toBe(12000);
    });

    it("carries unknown fields on a marker, a lap entry, a car record, a laps session and the laps section", async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          sections: {
            markers: [{ frame: 5, sessionNum: 0, sessionTimeMs: 1, label: "lift" }],
            laps: {
              version: 1,
              source: "live",
              sessions: [
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  weather: "dry",
                  cars: {
                    "7": {
                      carNumberRaw: 2,
                      userId: 1,
                      team: "A",
                      laps: [{ lap: 1, frame: 10, timeMs: null, valid: true }],
                    },
                  },
                },
              ],
            },
          },
        }),
      );

      store.setActiveSession(header());
      store.markers.add({ frame: 500, sessionNum: 0, sessionTimeMs: 0 });
      store.laps.recordLapStart(lapStart({ lap: 2, frame: 20 }));
      store.laps.recordLapTime({ sessionNum: 2, sessionUniqueId: 3, carIdx: 7, lap: 1, timeMs: 90000 });
      await store.flush();

      const { sections } = JSON.parse(readFileSync(filePath, "utf-8"));

      expect(sections.markers[0]).toEqual({ frame: 5, sessionNum: 0, sessionTimeMs: 1, label: "lift" });
      expect(sections.laps.source).toBe("live");
      expect(sections.laps.sessions[0].weather).toBe("dry");
      expect(sections.laps.sessions[0].cars["7"].team).toBe("A");
      expect(sections.laps.sessions[0].cars["7"].laps[0]).toEqual({ lap: 1, frame: 10, timeMs: 90000, valid: true });
      expect(sections.laps.sessions[0].cars["7"].laps[1]).toEqual({ lap: 2, frame: 20, timeMs: null });
    });

    it("carries a laps section from a newer build through verbatim, and neither reads nor writes it", async () => {
      const newer = { version: 2, sessions: [{ sessionNum: 2, sessionUniqueId: 3, stints: [{ from: 1, to: 9 }] }] };

      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({ version: 1, sections: { laps: newer } }));

      store.setActiveSession(header());

      expect(store.laps.recordLapStart(lapStart())).toBe(false);
      expect(store.laps.recordLapTime({ sessionNum: 2, sessionUniqueId: 3, carIdx: 7, lap: 1, timeMs: 1 })).toBe(false);
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "newer format" });

      store.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.laps).toEqual(newer);
    });

    it("carries a markers entry it cannot read through every write, after the markers it can", async () => {
      const span = { kind: "span", frames: [100, 900] };

      mkdirSync(dir, { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          sections: { markers: [span, { frame: 5000, sessionNum: 0, sessionTimeMs: 1 }] },
        }),
      );

      store.setActiveSession(header());
      expect(store.markers.list().map((m) => m.frame)).toEqual([5000]);
      store.markers.add({ frame: 1, sessionNum: 0, sessionTimeMs: 0 });
      await store.flush();
      store.markers.deleteNearest(5000);
      await store.flush();

      expect(JSON.parse(readFileSync(filePath, "utf-8")).sections.markers).toEqual([
        { frame: 1, sessionNum: 0, sessionTimeMs: 0 },
        span,
      ]);
    });
  });

  describe("markers through the store", () => {
    it("ignores a call whose scope names another session, and takes one naming the active session", () => {
      store.setActiveSession(header());

      expect(store.markers.add({ frame: 1000, sessionNum: 2, sessionTimeMs: 10 }, { subSessionId: SUB + 1 })).toBe(
        false,
      );
      expect(store.markers.add({ frame: 1000, sessionNum: 2, sessionTimeMs: 10 }, { subSessionId: SUB })).toBe(true);
      expect(store.markers.deleteNearest(1000, { subSessionId: SUB + 1 })).toBeNull();
      expect(store.markers.next(0, { subSessionId: SUB + 1 })).toBeNull();
      expect(store.markers.previous(5000, { subSessionId: SUB + 1 })).toBeNull();
      expect(store.markers.list({ subSessionId: SUB + 1 })).toEqual([]);
      expect(store.markers.list({ subSessionId: SUB })).toHaveLength(1);
      expect(store.markers.deleteNearest(1000, { subSessionId: SUB })?.frame).toBe(1000);
    });

    it("list() returns a copy the caller cannot mutate the store through", () => {
      store.setActiveSession(header());
      store.markers.add({ frame: 1000, sessionNum: 2, sessionTimeMs: 10 });

      const listed = store.markers.list();

      listed.push({ frame: 9, sessionNum: 0, sessionTimeMs: 0 });
      listed[0]!.frame = 1;

      expect(store.markers.list()).toEqual([{ frame: 1000, sessionNum: 2, sessionTimeMs: 10 }]);
    });

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
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no file" });
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
      // Nothing was LOADED and nothing recorded: the plugin has no lap record
      // for this session, which is "no file" to the action's log.
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no file" });
    });

    it("misses with 'no file' for a record the plugin neither loaded nor recorded into, and 'no session' for a loaded file without the session", () => {
      // Someone else's .rpy: no file for its SubSessionID.
      store.setActiveSession(header(SUB + 5));
      expect(store.laps.findLapStart({ ...lapStart(), subSessionId: SUB + 5 })).toEqual({
        hit: false,
        reason: "no file",
      });

      // A file this plugin wrote earlier, with markers but no laps section.
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({ version: 1, sections: { markers: [{ frame: 5, sessionNum: 0, sessionTimeMs: 1 }] } }),
      );
      store.setActiveSession(header());
      expect(store.laps.findLapStart(lapStart())).toEqual({ hit: false, reason: "no session" });

      // A live session with a lap recorded for another session number.
      store.setActiveSession(header(SUB + 6));
      store.laps.recordLapStart(lapStart({ sessionNum: 9 }));
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
