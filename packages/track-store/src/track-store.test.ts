import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import {
  PIT_LANE_SECTION_VERSION,
  type PitLaneLandmarkName,
  type PitLaneLandmarkSample,
  type PitLaneTrackIdentity,
} from "@iracedeck/track-data";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRACK_FILE_VERSION, type TrackFile } from "./track-file.js";
import {
  _resetTrackStore,
  createTrackStore,
  initializeTrackStore,
  nodeTrackStoreIo,
  TRACK_STORE_STALE_TEMP_MS,
  TRACK_STORE_WRITE_DEBOUNCE_MS,
  TRACK_STORE_WRITE_MAX_WAIT_MS,
  type TrackStore,
  type TrackStoreIo,
  type TrackStoreOptions,
} from "./track-store.js";

const TRACK: PitLaneTrackIdentity = {
  sim: "iracing",
  trackId: 101,
  trackName: "spa 2024 gp",
  trackConfigName: "Grand Prix",
  trackLength: "6.93 km",
  trackLengthM: 6930,
  trackVersion: "2025.03.01.02",
};

const T0 = Date.parse("2026-11-09T12:00:00.000Z");

/** The track data root the store is given. */
let dir: string;
/** Its `iracing` folder, where {@link TRACK}'s files live. */
let simDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "track-store-"));
  simDir = join(dir, "iracing");
});

afterEach(() => {
  vi.useRealTimers();
  _resetTrackStore();
  rmSync(dir, { recursive: true, force: true });
});

function filePath(trackId = TRACK.trackId): string {
  return join(simDir, `track_${trackId}.json`);
}

/** Write a file in the sim's folder, creating the folder as another process's write would have. */
function writeInSimDir(path: string, data: string | Buffer, encoding?: "utf-8"): void {
  mkdirSync(simDir, { recursive: true });
  writeFileSync(path, data, encoding);
}

function readFile(): TrackFile {
  return JSON.parse(readFileSync(filePath(), "utf-8")) as TrackFile;
}

function sample(key: string, pct: number, at: number, overrides: Partial<PitLaneLandmarkSample> = {}) {
  return { pct, estTime: 40 + pct, carClassId: 4029, key, at, ...overrides };
}

function windowKeys(file: TrackFile, landmark: PitLaneLandmarkName = "pitRoadStart"): string[] {
  return (file.pitLane.landmarks[landmark]?.window ?? []).map((kept) => kept.key).sort();
}

function spyLogger(): ILogger & Record<"trace" | "debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>> {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return logger;
}

function makeStore(overrides: Partial<TrackStoreOptions> = {}): TrackStore {
  return createTrackStore({ directory: dir, logger: silentLogger, ...overrides });
}

function record(
  store: TrackStore,
  key: string,
  pct: number,
  at: number,
  landmark: PitLaneLandmarkName = "pitRoadStart",
) {
  return store.recordSample({ track: TRACK, landmark, sample: sample(key, pct, at) });
}

/** A file on disk as another build or process would have written it. */
function writeTrackFile(overrides: Record<string, unknown> = {}, landmarks: Record<string, unknown> = {}): string {
  const text = JSON.stringify({
    version: TRACK_FILE_VERSION,
    sim: "iracing",
    trackId: TRACK.trackId,
    trackName: TRACK.trackName,
    trackConfigName: TRACK.trackConfigName,
    trackLength: TRACK.trackLength,
    trackVersion: TRACK.trackVersion,
    pitLane: { version: PIT_LANE_SECTION_VERSION, trackLength: TRACK.trackLength, landmarks },
    ...overrides,
  });

  writeInSimDir(filePath(), text, "utf-8");

  return text;
}

/** A landmark record with the given window, as a file would hold it. */
function recordOf(window: Array<PitLaneLandmarkSample & Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    pct: window[0]!.pct,
    estTimeByClass: {},
    samples: window.length,
    updatedAt: "2026-11-01T00:00:00.000Z",
    origin: "learned",
    window,
    ...extra,
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe("an absent file", () => {
  it("loads as null and creates nothing", () => {
    const store = makeStore();

    expect(store.load(TRACK)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is created on the first write, the envelope from the session's identity", () => {
    vi.useFakeTimers({ now: T0 });
    const logger = spyLogger();
    const store = makeStore({ logger });

    expect(record(store, "1:0:5:pitRoadStart:3", 0.1, T0)).toBe(true);
    expect(existsSync(filePath())).toBe(false);

    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    const file = readFile();

    expect(file).toMatchObject({
      version: TRACK_FILE_VERSION,
      sim: "iracing",
      trackId: 101,
      trackName: "spa 2024 gp",
      trackConfigName: "Grand Prix",
      trackLength: "6.93 km",
      trackVersion: "2025.03.01.02",
      pitLane: { version: PIT_LANE_SECTION_VERSION, trackLength: "6.93 km", trackVersion: "2025.03.01.02" },
    });
    expect(file.pitLane.landmarks.pitRoadStart).toMatchObject({ samples: 1, origin: "learned", pct: 0.1 });
    expect(windowKeys(file)).toEqual(["1:0:5:pitRoadStart:3"]);
    expect(readdirSync(simDir)).toEqual(["track_101.json"]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("created"));
    // Compact JSON, one line.
    expect(readFileSync(filePath(), "utf-8").trimEnd()).not.toContain("\n");
  });
});

describe("the debounce", () => {
  it("writes once after a quiet debounce", () => {
    vi.useFakeTimers({ now: T0 });
    const writes: string[] = [];
    const store = makeStore({
      io: { ...nodeTrackStoreIo, writeText: (p, t) => (writes.push(p), nodeTrackStoreIo.writeText(p, t)) },
    });

    record(store, "a", 0.1, T0, "approachStart");
    record(store, "b", 0.11, T0, "pitRoadStart");
    record(store, "c", 0.2, T0, "pitRoadEnd");
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS - 1);

    expect(writes).toHaveLength(0);

    vi.advanceTimersByTime(1);

    expect(writes).toHaveLength(1);
    expect(Object.keys(readFile().pitLane.landmarks).sort()).toEqual(["approachStart", "pitRoadEnd", "pitRoadStart"]);
  });

  it("never waits past the max wait while samples keep coming", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();
    const step = TRACK_STORE_WRITE_DEBOUNCE_MS / 2;
    let elapsed = 0;

    while (elapsed < TRACK_STORE_WRITE_MAX_WAIT_MS - step) {
      record(store, `k${elapsed}`, 0.1, T0 + elapsed);
      vi.advanceTimersByTime(step);
      elapsed += step;
    }

    expect(existsSync(filePath())).toBe(false);

    record(store, `k${elapsed}`, 0.1, T0 + elapsed);
    vi.advanceTimersByTime(step);

    expect(existsSync(filePath())).toBe(true);
  });
});

describe("load", () => {
  it("returns this process's samples before the first write", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();

    record(store, "a", 0.1, T0);
    record(store, "b", 0.1001, T0 + 1);

    const section = store.load(TRACK);

    expect(section?.landmarks.pitRoadStart?.window.map((kept) => kept.key)).toEqual(["a", "b"]);
    expect(section?.landmarks.pitRoadStart?.samples).toBe(2);
    expect(existsSync(filePath())).toBe(false);
  });

  it("returns a copy", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();

    record(store, "a", 0.1, T0);

    const first = store.load(TRACK)!;

    first.landmarks.pitRoadStart!.window.length = 0;

    expect(store.load(TRACK)?.landmarks.pitRoadStart?.window).toHaveLength(1);
  });

  it("reads the file once and serves it from memory after that", () => {
    writeTrackFile({}, { pitRoadEnd: recordOf([sample("disk", 0.2, T0 - 1000)]) });
    const store = makeStore();

    expect(store.load(TRACK)?.landmarks.pitRoadEnd?.window.map((kept) => kept.key)).toEqual(["disk"]);

    writeTrackFile({}, { pitRoadEnd: recordOf([sample("later", 0.2, T0 - 500)]) });

    expect(store.load(TRACK)?.landmarks.pitRoadEnd?.window.map((kept) => kept.key)).toEqual(["disk"]);

    // ...while a write merges what the disk holds by then.
    record(store, "mine", 0.2, T0, "pitRoadEnd");
    store.flushSync();

    expect(windowKeys(readFile(), "pitRoadEnd")).toEqual(["later", "mine"]);
    expect(store.load(TRACK)?.landmarks.pitRoadEnd?.window.map((kept) => kept.key)).toEqual(["later", "mine"]);
  });

  it("never throws, whatever the IO does", () => {
    const logger = spyLogger();
    const store = makeStore({
      logger,
      // Decodes to something that is not a string, so the parse itself throws.
      io: { ...nodeTrackStoreIo, readBytes: () => ({ toString: () => undefined }) as unknown as Buffer },
    });

    expect(store.load(TRACK)).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("recordSample", () => {
  it("refuses a duplicate, a malformed sample and an unknown landmark, and schedules nothing", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();

    expect(record(store, "a", 0.1, T0)).toBe(true);
    store.flushSync();

    const before = readFileSync(filePath(), "utf-8");

    expect(record(store, "a", 0.1, T0 + 1000)).toBe(false);
    expect(store.recordSample({ track: TRACK, landmark: "pitRoadStart", sample: sample("b", 1.5, T0) })).toBe(false);
    expect(
      store.recordSample({
        track: TRACK,
        landmark: "pitBox" as PitLaneLandmarkName,
        sample: sample("c", 0.1, T0),
      }),
    ).toBe(false);

    vi.advanceTimersByTime(TRACK_STORE_WRITE_MAX_WAIT_MS * 2);

    expect(readFileSync(filePath(), "utf-8")).toBe(before);
  });
});

describe("a malformed file", () => {
  it.each([
    ["not JSON", "{not json"],
    ["not a track file", JSON.stringify({ version: 1, hello: "world" })],
  ])("(%s) is left alone by load, then moved aside and preserved by the write", (_label, text) => {
    writeInSimDir(filePath(), text, "utf-8");
    const logger = spyLogger();
    const store = makeStore({ logger, now: () => new Date(T0) });

    expect(store.load(TRACK)).toBeNull();
    expect(readFileSync(filePath(), "utf-8")).toBe(text);

    record(store, "a", 0.1, T0);
    store.flushSync();

    const asides = readdirSync(simDir).filter((name) => name.startsWith("track_101.corrupt-"));

    expect(asides).toEqual(["track_101.corrupt-2026-11-09T12-00-00-000Z.json"]);
    expect(readFileSync(join(simDir, asides[0]!), "utf-8")).toBe(text);
    expect(windowKeys(readFile())).toEqual(["a"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not valid"));
  });

  it("never overwrites an earlier aside", () => {
    writeInSimDir(filePath(), "{one", "utf-8");
    writeInSimDir(join(simDir, "track_101.corrupt-2026-11-09T12-00-00-000Z.json"), "{earlier", "utf-8");
    const store = makeStore({ now: () => new Date(T0) });

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(readFileSync(join(simDir, "track_101.corrupt-2026-11-09T12-00-00-000Z.json"), "utf-8")).toBe("{earlier");
    expect(readFileSync(join(simDir, "track_101.corrupt-2026-11-09T12-00-00-000Z-1.json"), "utf-8")).toBe("{one");
  });

  it("is compared as bytes: two invalid-UTF-8 files are not taken as identical", () => {
    writeInSimDir(filePath(), Buffer.from([0x7b, 0xfe]));
    writeInSimDir(join(simDir, "track_101.corrupt-earlier.json"), Buffer.from([0x7b, 0xff]));
    const store = makeStore({
      now: () => new Date(T0),
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (to.includes(".corrupt-")) throw errno("EPERM");

          nodeTrackStoreIo.rename(from, to);
        },
      },
    });

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect([...readFileSync(join(simDir, "track_101.corrupt-2026-11-09T12-00-00-000Z.json"))]).toEqual([0x7b, 0xfe]);
    expect([...readFileSync(join(simDir, "track_101.corrupt-earlier.json"))]).toEqual([0x7b, 0xff]);
    expect(windowKeys(readFile())).toEqual(["a"]);
  });

  it("is copied once when the write after the copy fails and is retried", () => {
    vi.useFakeTimers({ now: T0 });
    writeInSimDir(filePath(), "{locked", "utf-8");
    let tmpRenameFailures = 1;
    let copies = 0;
    const store = makeStore({
      retryDelaysMs: [100],
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (to.includes(".corrupt-")) throw errno("EPERM");

          if (tmpRenameFailures > 0 && from.endsWith(".tmp")) {
            tmpRenameFailures--;
            throw errno("EPERM");
          }

          nodeTrackStoreIo.rename(from, to);
        },
        copyExclusive: (from, to) => (copies++, nodeTrackStoreIo.copyExclusive(from, to)),
      },
    });

    record(store, "a", 0.1, T0);
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    expect(readFileSync(filePath(), "utf-8")).toBe("{locked");
    expect(copies).toBe(1);

    vi.advanceTimersByTime(100);

    expect(copies).toBe(1);
    // Stamped when the first write ran, one debounce after the sample.
    expect(readdirSync(simDir).filter((name) => name.includes(".corrupt-"))).toEqual([
      "track_101.corrupt-2026-11-09T12-00-02-000Z.json",
    ]);
    expect(windowKeys(readFile())).toEqual(["a"]);
  });

  it("is not moved aside when another process's valid write replaced it after the read", () => {
    writeInSimDir(filePath(), "{broken", "utf-8");
    const valid = { pitRoadStart: recordOf([sample("theirs", 0.1, T0 - 1000)]) };
    let armed = false;
    let replaced = false;
    const store = makeStore({
      io: {
        ...nodeTrackStoreIo,
        readBytes: (p) => {
          const bytes = nodeTrackStoreIo.readBytes(p);

          // The write's own read: it classifies the corrupt bytes, then the
          // other process's rename lands before the move aside.
          if (armed && !replaced && p === filePath() && bytes.toString("utf-8") === "{broken") {
            replaced = true;
            writeTrackFile({}, valid);
          }

          return bytes;
        },
      },
    });

    record(store, "mine", 0.1001, T0);
    armed = true;
    store.flushSync();

    expect(replaced).toBe(true);
    expect(readdirSync(simDir)).toEqual(["track_101.json"]);
    expect(windowKeys(readFile())).toEqual(["mine", "theirs"]);
  });

  it("is preserved as a copy when it cannot be renamed", () => {
    writeInSimDir(filePath(), "{locked", "utf-8");
    const store = makeStore({
      now: () => new Date(T0),
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (to.includes(".corrupt-")) throw errno("EPERM");

          nodeTrackStoreIo.rename(from, to);
        },
      },
    });

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(readFileSync(join(simDir, "track_101.corrupt-2026-11-09T12-00-00-000Z.json"), "utf-8")).toBe("{locked");
    expect(windowKeys(readFile())).toEqual(["a"]);
  });

  it("is never written over when it cannot be preserved", () => {
    writeInSimDir(filePath(), "{stuck", "utf-8");
    const logger = spyLogger();
    const store = makeStore({
      logger,
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (to.includes(".corrupt-")) throw errno("EPERM");

          nodeTrackStoreIo.rename(from, to);
        },
        copyExclusive: () => {
          throw errno("EACCES");
        },
      },
    });

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(readFileSync(filePath(), "utf-8")).toBe("{stuck");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("could not be preserved"));
  });
});

describe("an unreadable file", () => {
  it("is never written over, and is merged once it can be read", () => {
    vi.useFakeTimers({ now: T0 });
    const text = writeTrackFile({}, { pitRoadStart: recordOf([sample("disk", 0.1, T0 - 5000)]) });
    let locked = true;
    const store = makeStore({
      retryDelaysMs: [100, 200],
      io: {
        ...nodeTrackStoreIo,
        readBytes: (path) => {
          if (locked && path === filePath()) throw errno("EBUSY");

          return nodeTrackStoreIo.readBytes(path);
        },
      },
    });

    record(store, "mine", 0.1001, T0);
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    expect(readFileSync(filePath(), "utf-8")).toBe(text);

    vi.advanceTimersByTime(100);

    expect(readFileSync(filePath(), "utf-8")).toBe(text);

    locked = false;
    vi.advanceTimersByTime(200);

    expect(windowKeys(readFile())).toEqual(["disk", "mine"]);
    expect(readFile().pitLane.landmarks.pitRoadStart?.samples).toBe(2);
  });

  it("keeps the sample for the next sample or the shutdown flush once the retries run out", () => {
    vi.useFakeTimers({ now: T0 });
    let locked = true;
    const store = makeStore({
      retryDelaysMs: [100],
      io: {
        ...nodeTrackStoreIo,
        readBytes: (path) => {
          if (locked) throw errno("EBUSY");

          return nodeTrackStoreIo.readBytes(path);
        },
      },
    });

    writeTrackFile();
    record(store, "mine", 0.1, T0);
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS + 1000);
    locked = false;
    store.flushSync();

    expect(windowKeys(readFile())).toEqual(["mine"]);
  });
});

describe("a file from a newer build", () => {
  it.each([
    ["envelope", { version: TRACK_FILE_VERSION + 1 }],
    ["pit-lane section", { pitLane: { version: PIT_LANE_SECTION_VERSION + 1, somethingNew: [] } }],
  ])("(newer %s) is never read nor written, and warned about once", (_label, overrides) => {
    const text = writeTrackFile(overrides);
    const logger = spyLogger();
    const store = makeStore({ logger });

    expect(store.load(TRACK)).toBeNull();

    record(store, "a", 0.1, T0);
    store.flushSync();
    record(store, "b", 0.1, T0 + 1);
    store.flushSync();

    expect(readFileSync(filePath(), "utf-8")).toBe(text);
    expect(readdirSync(simDir)).toEqual(["track_101.json"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("newer version"));
    // Kept in memory for this process.
    expect(store.load(TRACK)?.landmarks.pitRoadStart?.window).toHaveLength(2);
  });
});

describe("a file of another track", () => {
  it("is treated as no data and never written over", () => {
    const text = writeTrackFile({ trackName: "monza full" }, { pitRoadStart: recordOf([sample("theirs", 0.5, T0)]) });
    const logger = spyLogger();
    const store = makeStore({ logger });

    expect(store.load(TRACK)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("another track"));

    record(store, "mine", 0.1, T0);

    expect(store.load(TRACK)?.landmarks.pitRoadStart?.window.map((kept) => kept.key)).toEqual(["mine"]);

    store.flushSync();

    expect(readFileSync(filePath(), "utf-8")).toBe(text);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("is one whose envelope names another sim than the identity's, in the identity's folder", () => {
    const text = writeTrackFile({ sim: "other-sim" }, { pitRoadStart: recordOf([sample("theirs", 0.5, T0)]) });
    const logger = spyLogger();
    const store = makeStore({ logger });

    expect(store.load(TRACK)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sim "other-sim" is not "iracing"'));

    record(store, "mine", 0.1, T0);
    store.flushSync();

    expect(readFileSync(filePath(), "utf-8")).toBe(text);
  });
});

describe("the sim's folder", () => {
  const OTHER: PitLaneTrackIdentity = { ...TRACK, sim: "other-sim", trackName: "another sim's spa" };

  it("holds each sim's file under the identity's sim, with that sim in the envelope", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(readdirSync(dir)).toEqual(["iracing"]);
    expect(readdirSync(simDir)).toEqual(["track_101.json"]);
    expect(readFile().sim).toBe("iracing");
  });

  it("keeps two sims' tracks with one id apart", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();

    record(store, "mine", 0.1, T0);
    store.recordSample({ track: OTHER, landmark: "pitRoadStart", sample: sample("other", 0.7, T0) });
    store.flushSync();

    expect(readdirSync(dir).sort()).toEqual(["iracing", "other-sim"]);
    expect(windowKeys(readFile())).toEqual(["mine"]);

    const other = JSON.parse(readFileSync(join(dir, "other-sim", "track_101.json"), "utf-8")) as TrackFile;

    expect(other).toMatchObject({ sim: "other-sim", trackId: 101, trackName: "another sim's spa" });
    expect(windowKeys(other)).toEqual(["other"]);
    expect(store.load(TRACK)?.landmarks.pitRoadStart?.window.map((kept) => kept.key)).toEqual(["mine"]);
    expect(store.load(OTHER)?.landmarks.pitRoadStart?.window.map((kept) => kept.key)).toEqual(["other"]);
  });

  it.each(["", "Iracing", "../escape", "a/b", "a\\b", ".", "-lead", "has space", "con", "LPT1", "x".repeat(33)])(
    "refuses an identity whose sim cannot name a folder (%j), warning once",
    (sim) => {
      vi.useFakeTimers({ now: T0 });
      const logger = spyLogger();
      const store = makeStore({ logger });
      const track = { ...TRACK, sim };

      expect(store.load(track)).toBeNull();
      expect(store.recordSample({ track, landmark: "pitRoadStart", sample: sample("a", 0.1, T0) })).toBe(false);
      store.flushSync();
      vi.advanceTimersByTime(TRACK_STORE_WRITE_MAX_WAIT_MS * 2);

      expect(readdirSync(dir)).toEqual([]);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(sim)));
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it("accepts a sim of lowercase letters, digits and hyphens", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();
    const track = { ...TRACK, sim: "sim-2" };

    expect(store.recordSample({ track, landmark: "pitRoadStart", sample: sample("a", 0.1, T0) })).toBe(true);
    store.flushSync();

    expect(existsSync(join(dir, "sim-2", "track_101.json"))).toBe(true);
  });
});

describe("unknown keys", () => {
  it("survive every write, at every level", () => {
    writeTrackFile(
      {
        futureEnvelope: { keep: true },
        pitLane: {
          version: PIT_LANE_SECTION_VERSION,
          trackLength: TRACK.trackLength,
          futureSection: 7,
          landmarks: {
            pitRoadStart: recordOf([{ ...sample("disk", 0.1, T0 - 1000), futureSample: "x" }], { futureRecord: "y" }),
            pitExitBlend2: { notYetKnown: true },
          },
        },
      },
      {},
    );
    const store = makeStore();

    record(store, "mine", 0.1001, T0);
    store.flushSync();

    const file = readFile() as TrackFile & { futureEnvelope: unknown };

    expect(file.futureEnvelope).toEqual({ keep: true });
    expect(file.pitLane.futureSection).toBe(7);
    expect(file.pitLane.landmarks.pitExitBlend2).toEqual({ notYetKnown: true });
    expect(file.pitLane.landmarks.pitRoadStart?.futureRecord).toBe("y");
    expect(file.pitLane.landmarks.pitRoadStart?.window.find((kept) => kept.key === "disk")).toMatchObject({
      futureSample: "x",
    });
  });
});

describe("the atomic write", () => {
  it("leaves the old file whole and no temp file when the rename fails, then retries", () => {
    vi.useFakeTimers({ now: T0 });
    const text = writeTrackFile({}, { pitRoadEnd: recordOf([sample("disk", 0.2, T0 - 1000)]) });
    let failures = 1;
    const store = makeStore({
      retryDelaysMs: [100],
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (failures > 0 && from.endsWith(".tmp")) {
            failures--;
            throw errno("EPERM");
          }

          nodeTrackStoreIo.rename(from, to);
        },
      },
    });

    record(store, "mine", 0.1, T0);
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    expect(readFileSync(filePath(), "utf-8")).toBe(text);
    expect(readdirSync(simDir)).toEqual(["track_101.json"]);

    vi.advanceTimersByTime(100);

    expect(windowKeys(readFile())).toEqual(["mine"]);
    expect(windowKeys(readFile(), "pitRoadEnd")).toEqual(["disk"]);
    expect(readdirSync(simDir)).toEqual(["track_101.json"]);
  });

  it("writes through a temp file named for the process", () => {
    const renames: Array<[string, string]> = [];
    const store = makeStore({
      pid: 4242,
      io: { ...nodeTrackStoreIo, rename: (from, to) => (renames.push([from, to]), nodeTrackStoreIo.rename(from, to)) },
    });

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(renames).toEqual([[`${filePath()}.4242.tmp`, filePath()]]);
  });
});

describe("two processes sharing the folder", () => {
  it("end with the union of their samples and the right counts", () => {
    const a = makeStore({ pid: 1001 });
    const b = makeStore({ pid: 1002 });

    record(a, "a1", 0.1, T0);
    record(b, "b1", 0.1001, T0 + 10);
    a.flushSync();
    b.flushSync();
    record(a, "a2", 0.1002, T0 + 20);
    record(a, "a3", 0.3, T0 + 25, "pitRoadEnd");
    b.flushSync();
    a.flushSync();
    record(b, "b2", 0.0999, T0 + 30);
    b.flushSync();

    const file = readFile();

    expect(windowKeys(file)).toEqual(["a1", "a2", "b1", "b2"]);
    expect(file.pitLane.landmarks.pitRoadStart?.samples).toBe(4);
    expect(windowKeys(file, "pitRoadEnd")).toEqual(["a3"]);
    expect(file.pitLane.landmarks.pitRoadEnd?.samples).toBe(1);
  });

  it("count an edge both processes saw once", () => {
    const a = makeStore({ pid: 1001 });
    const b = makeStore({ pid: 1002 });

    record(a, "shared", 0.1, T0);
    a.flushSync();
    record(b, "shared", 0.1, T0 + 800);
    b.flushSync();

    expect(readFile().pitLane.landmarks.pitRoadStart?.samples).toBe(1);
  });

  it("heal a write that landed between the other's read and rename, at the settle check", () => {
    vi.useFakeTimers({ now: T0 });
    const a = makeStore({ pid: 1001 });
    let raced = false;
    const b = makeStore({
      pid: 1002,
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (!raced && from.endsWith(".1002.tmp")) {
            raced = true;
            // A's debounced write lands after B read the file and before B renames.
            vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);
          }

          nodeTrackStoreIo.rename(from, to);
        },
      },
    });

    record(a, "a1", 0.1, T0);
    record(b, "b1", 0.1001, T0);
    b.flushSync();

    expect(raced).toBe(true);
    expect(windowKeys(readFile())).toEqual(["b1"]);

    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    expect(windowKeys(readFile())).toEqual(["a1", "b1"]);
    expect(readFile().pitLane.landmarks.pitRoadStart?.samples).toBe(2);
  });

  it("heal the same race on the next write", () => {
    const a = makeStore({ pid: 1001 });
    let raced = false;
    const b = makeStore({
      pid: 1002,
      io: {
        ...nodeTrackStoreIo,
        rename: (from, to) => {
          if (!raced && from.endsWith(".1002.tmp")) {
            raced = true;
            a.flushSync();
          }

          nodeTrackStoreIo.rename(from, to);
        },
      },
    });

    record(a, "a1", 0.1, T0);
    record(b, "b1", 0.1001, T0);
    b.flushSync();

    expect(windowKeys(readFile())).toEqual(["b1"]);

    record(a, "a2", 0.1002, T0 + 100);
    a.flushSync();

    expect(windowKeys(readFile())).toEqual(["a1", "a2", "b1"]);
    expect(readFile().pitLane.landmarks.pitRoadStart?.samples).toBe(3);
  });

  it("settle check reads the file once after a write and writes nothing when nothing is missing", () => {
    vi.useFakeTimers({ now: T0 });
    let writes = 0;
    let reads = 0;
    const store = makeStore({
      io: {
        ...nodeTrackStoreIo,
        writeText: (p, t) => (writes++, nodeTrackStoreIo.writeText(p, t)),
        readBytes: (p) => (p === filePath() && reads++, nodeTrackStoreIo.readBytes(p)),
      },
    });

    record(store, "a", 0.1, T0);
    const readsBeforeWrite = reads;

    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    expect(writes).toBe(1);
    expect(reads).toBe(readsBeforeWrite + 1);

    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS);

    // The check ran (one more read) and found nothing to write.
    expect(reads).toBe(readsBeforeWrite + 2);
    expect(writes).toBe(1);

    vi.advanceTimersByTime(TRACK_STORE_WRITE_MAX_WAIT_MS * 3);

    expect(reads).toBe(readsBeforeWrite + 2);
    expect(writes).toBe(1);
  });

  it("on two builds of one track, never rebuild each other's file from the settle check", () => {
    vi.useFakeTimers({ now: T0 });
    const REBUILT: PitLaneTrackIdentity = { ...TRACK, trackLength: "6.95 km", trackLengthM: 6950 };
    let writes = 0;
    const counting: TrackStoreIo = {
      ...nodeTrackStoreIo,
      writeText: (p, t) => (writes++, nodeTrackStoreIo.writeText(p, t)),
    };
    const logger = spyLogger();
    const a = makeStore({ pid: 1001, io: counting, logger });
    const b = makeStore({ pid: 1002, io: counting });

    a.recordSample({ track: TRACK, landmark: "pitRoadStart", sample: sample("a1", 0.1, T0) });
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS / 2);
    b.recordSample({ track: REBUILT, landmark: "pitRoadStart", sample: sample("b1", 0.1, T0 + 1) });
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS * 50);

    // One save each; the settle checks see the other length and leave it.
    expect(writes).toBe(2);
    expect(readFile().trackLength).toBe("6.95 km");
    expect(windowKeys(readFile())).toEqual(["b1"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("another build of the track"));

    // A learned sample still writes, rebuilding to that process's length.
    a.recordSample({ track: TRACK, landmark: "pitRoadStart", sample: sample("a2", 0.1, T0 + 2) });
    vi.advanceTimersByTime(TRACK_STORE_WRITE_DEBOUNCE_MS * 50);

    expect(writes).toBe(3);
    expect(readFile().trackLength).toBe("6.93 km");
  });
});

describe("a rebuilt track", () => {
  const published = recordOf([sample("old1", 0.1, T0 - 2000), sample("old2", 0.1001, T0 - 1000)]);
  const REBUILT: PitLaneTrackIdentity = { ...TRACK, trackLength: "6.95 km", trackLengthM: 6950 };

  it("loads with the old values under previous and the window reset", () => {
    writeTrackFile({}, { pitRoadStart: published });
    const store = makeStore();
    const section = store.load(REBUILT);

    expect(section?.trackLength).toBe("6.95 km");
    expect(section?.landmarks.pitRoadStart).toMatchObject({
      samples: 0,
      window: [],
      previous: { pct: 0.1, samples: 2 },
    });
  });

  it("writes the new geometry with the previous values kept until it publishes again", () => {
    writeTrackFile({}, { pitRoadStart: published });
    const store = makeStore();

    store.recordSample({ track: REBUILT, landmark: "pitRoadStart", sample: sample("new1", 0.105, T0) });
    store.flushSync();

    const file = readFile();

    expect(file.trackLength).toBe("6.95 km");
    expect(file.pitLane.trackLength).toBe("6.95 km");
    expect(windowKeys(file)).toEqual(["new1"]);
    expect(file.pitLane.landmarks.pitRoadStart).toMatchObject({ samples: 1, previous: { pct: 0.1, samples: 2 } });
  });

  it("drops this process's samples of the old geometry", () => {
    const store = makeStore();

    record(store, "before", 0.1, T0);
    store.recordSample({ track: REBUILT, landmark: "pitRoadStart", sample: sample("after", 0.2, T0 + 1) });
    store.flushSync();

    expect(windowKeys(readFile())).toEqual(["after"]);
  });
});

describe("stale temp files", () => {
  it("are removed on init when their process is gone or they are old, and nothing else is", () => {
    const names = [
      "track_101.json.999991.tmp", // dead pid
      "track_101.json.4242.tmp", // live pid, fresh: mid-write in another process
      "track_102.json.4242.tmp", // live pid, but older than the stale age: the pid was reused
      "track_103.json.7777.tmp", // this process's pid: a previous process's leftover
      "track_101.json",
      "track_101.json.tmp",
      "track_101.corrupt-2026-11-09T12-00-00-000Z.json",
      "notes.tmp",
      "session_5.json.4242.tmp",
    ];

    for (const name of names) writeInSimDir(join(simDir, name), "x", "utf-8");

    const old = (Date.now() - TRACK_STORE_STALE_TEMP_MS - 60_000) / 1000;

    utimesSync(join(simDir, "track_102.json.4242.tmp"), old, old);

    const io: TrackStoreIo = { ...nodeTrackStoreIo, isProcessAlive: (pid) => pid === 4242 || pid === 7777 };

    makeStore({ pid: 7777, io });

    expect(readdirSync(simDir).sort()).toEqual(
      [
        "notes.tmp",
        "session_5.json.4242.tmp",
        "track_101.corrupt-2026-11-09T12-00-00-000Z.json",
        "track_101.json",
        "track_101.json.4242.tmp",
        "track_101.json.tmp",
      ].sort(),
    );
  });

  it("are looked for in every sim's folder, and nowhere else", () => {
    const dead = "track_7.json.999991.tmp";

    // Two sims' folders: each one's leftover goes.
    for (const sim of ["iracing", "other-sim"]) {
      mkdirSync(join(dir, sim));
      writeFileSync(join(dir, sim, dead), "x", "utf-8");
    }

    // The root and a folder no sim could be named are not the store's.
    writeFileSync(join(dir, dead), "x", "utf-8");
    mkdirSync(join(dir, "Not A Sim"));
    writeFileSync(join(dir, "Not A Sim", dead), "x", "utf-8");
    // A file named like a sim is skipped, not a reason to fail.
    writeFileSync(join(dir, "plainfile"), "x", "utf-8");

    makeStore({ io: { ...nodeTrackStoreIo, isProcessAlive: () => false } });

    expect(readdirSync(join(dir, "iracing"))).toEqual([]);
    expect(readdirSync(join(dir, "other-sim"))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["Not A Sim", "iracing", "other-sim", "plainfile", dead].sort());
    expect(readdirSync(join(dir, "Not A Sim"))).toEqual([dead]);
  });

  it("are no reason to fail when the folder does not exist yet", () => {
    expect(() => createTrackStore({ directory: join(dir, "missing"), logger: silentLogger })).not.toThrow();
  });
});

describe("flushSync", () => {
  it("writes what is pending at once", () => {
    vi.useFakeTimers({ now: T0 });
    const store = makeStore();

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(windowKeys(readFile())).toEqual(["a"]);
  });

  it("writes nothing when nothing is pending", () => {
    const store = makeStore();

    store.load(TRACK);
    store.flushSync();

    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates the folder when it does not exist", () => {
    const nested = join(dir, "a", "b");
    const store = createTrackStore({ directory: nested, logger: silentLogger });

    record(store, "a", 0.1, T0);
    store.flushSync();

    expect(existsSync(join(nested, "iracing", "track_101.json"))).toBe(true);
  });
});

describe("the singleton", () => {
  it("initializes once, until reset", () => {
    const store = initializeTrackStore({ directory: dir, logger: silentLogger });

    expect(store.directory).toBe(dir);
    expect(() => initializeTrackStore({ directory: dir, logger: silentLogger })).toThrow(/already initialized/);

    _resetTrackStore();

    expect(initializeTrackStore({ directory: dir, logger: silentLogger })).not.toBe(store);
  });

  it("has no getter: the handle is the one initializeTrackStore returns", async () => {
    const barrel = await import("./index.js");

    expect(Object.keys(barrel)).not.toContain("getTrackStore");
    expect(Object.keys(barrel)).not.toContain("isTrackStoreInitialized");
    expect(Object.keys(barrel)).toContain("initializeTrackStore");
  });

  it("is reset without a timer of the old store writing afterwards", () => {
    vi.useFakeTimers({ now: T0 });
    const store = initializeTrackStore({ directory: dir, logger: silentLogger });

    record(store, "a", 0.1, T0);
    _resetTrackStore();
    vi.advanceTimersByTime(TRACK_STORE_WRITE_MAX_WAIT_MS * 2);

    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(filePath())).toBe(false);
  });
});
