import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FIRST_RUN_VERSION_KEY, resolveFirstRunDecision, runFirstRunCheck } from "./first-run.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ILogger;

type Persist = (version: string) => void;
type Open = () => void | Promise<unknown>;

let persistFirstRun: ReturnType<typeof vi.fn<Persist>>;
let persistLastSeen: ReturnType<typeof vi.fn<Persist>>;
let openGettingStarted: ReturnType<typeof vi.fn<Open>>;

beforeEach(() => {
  vi.clearAllMocks();
  persistFirstRun = vi.fn<Persist>();
  persistLastSeen = vi.fn<Persist>();
  openGettingStarted = vi.fn<Open>().mockResolvedValue(undefined);
});

const run = (extra: Record<string, unknown> = {}) =>
  runFirstRunCheck({
    currentVersion: "3.1.0",
    persistFirstRun,
    persistLastSeen,
    openGettingStarted,
    logger,
    ...extra,
  });

describe("resolveFirstRunDecision", () => {
  it("opens for a store nothing has ever written a version into", () => {
    expect(resolveFirstRunDecision({})).toBe("open");
  });

  it("skips once the decision has been recorded", () => {
    expect(resolveFirstRunDecision({ firstRunVersion: "3.1.0" })).toBe("skip");
  });

  it("treats a bare `true` marker from any build as recorded", () => {
    expect(resolveFirstRunDecision({ firstRunVersion: true })).toBe("skip");
  });

  it("records silently for an install some earlier build has already started", () => {
    // `_lastSeenVersion` is the evidence: written on essentially every startup
    // since #680, and carried across verbatim by a host migration, so an
    // upgrading user is identified as not new whatever store source they hit.
    expect(resolveFirstRunDecision({ lastSeenVersion: "3.0.0" })).toBe("record-silently");
  });

  it("counts a MALFORMED last-seen version as evidence of prior use", () => {
    // Deliberately weaker than shouldOpenChangelog's test: the value is useless
    // for comparing versions but still proves some build wrote it here, and
    // proving that is this function's whole job.
    expect(resolveFirstRunDecision({ lastSeenVersion: "not-a-version" })).toBe("record-silently");
  });

  it("does not count an empty or blank last-seen version", () => {
    expect(resolveFirstRunDecision({ lastSeenVersion: "" })).toBe("open");
    expect(resolveFirstRunDecision({ lastSeenVersion: "   " })).toBe("open");
    expect(resolveFirstRunDecision({ lastSeenVersion: 3 })).toBe("open");
  });

  describe("while the settings migration is still pending", () => {
    it("defers rather than guessing", () => {
      // The countdown means a host answer may still arrive and prove this an
      // upgrade. On Mirabox, while #1056 stands, this is the normal path.
      expect(resolveFirstRunDecision({ migrationPending: 1 })).toBe("defer");
    });

    it("defers even though nothing has ever been seen here", () => {
      expect(resolveFirstRunDecision({ migrationPending: 2, lastSeenVersion: undefined })).toBe("defer");
    });

    it("still skips when the decision was already recorded", () => {
      expect(resolveFirstRunDecision({ migrationPending: 1, firstRunVersion: "3.1.0" })).toBe("skip");
    });
  });
});

describe("runFirstRunCheck", () => {
  it("opens the page, then records BOTH keys", async () => {
    expect(await run()).toBe(true);

    expect(openGettingStarted).toHaveBeenCalledTimes(1);
    expect(persistFirstRun).toHaveBeenCalledWith("3.1.0");
    // The changelog is suppressed on this start, so the version must be marked
    // seen or the next start opens it as a pending release.
    expect(persistLastSeen).toHaveBeenCalledWith("3.1.0");
  });

  it("records the version rather than a bare true, so a later build can revisit it", () => {
    // The #1041 -> #1047 lesson, in the key name itself.
    expect(FIRST_RUN_VERSION_KEY).toBe("_firstRunVersion");
  });

  it("opens AFTER deciding, and records only once the open resolved", async () => {
    const order: string[] = [];

    openGettingStarted.mockImplementation(() => {
      order.push("open");

      return Promise.resolve();
    });
    persistFirstRun.mockImplementation(() => order.push("persist"));

    await run();

    expect(order).toEqual(["open", "persist"]);
  });

  describe("when the window cannot be opened", () => {
    it("records nothing, so a later start tries again", async () => {
      // The opposite trade-off to runVersionCheck's persist-first: this flag
      // means "the user was shown this", and a rejected open means they were not.
      openGettingStarted.mockRejectedValue(new Error("no server"));

      expect(await run()).toBe(true);
      expect(persistFirstRun).not.toHaveBeenCalled();
      expect(persistLastSeen).not.toHaveBeenCalled();
    });

    it("does not throw out of the startup path", async () => {
      openGettingStarted.mockRejectedValue(new Error("no server"));

      await expect(run()).resolves.toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("the #870 sim gate", () => {
    it("defers while iRacing is running, fully inert", async () => {
      expect(await run({ isSimRunning: () => true })).toBe(true);

      expect(openGettingStarted).not.toHaveBeenCalled();
      expect(persistFirstRun).not.toHaveBeenCalled();
      expect(persistLastSeen).not.toHaveBeenCalled();
    });

    it("opens when the sim is not running", async () => {
      await run({ isSimRunning: () => false });

      expect(openGettingStarted).toHaveBeenCalledTimes(1);
    });
  });

  describe("consuming the start", () => {
    it("consumes it on an open, so the changelog is suppressed rather than opened alongside", async () => {
      expect(await run()).toBe(true);
    });

    it("consumes it on a defer, so `_lastSeenVersion` stays pristine for the next start", async () => {
      // This is the load-bearing half of the deferral: the changelog check is
      // what would write that key, and writing it would destroy the only
      // evidence distinguishing a new user from an upgrade.
      expect(await run({ migrationPending: 1 })).toBe(true);
      expect(persistLastSeen).not.toHaveBeenCalled();
    });

    it("releases it for an existing install, which still wants its changelog", async () => {
      expect(await run({ lastSeenVersion: "3.0.0" })).toBe(false);

      expect(openGettingStarted).not.toHaveBeenCalled();
      expect(persistFirstRun).toHaveBeenCalledWith("3.1.0");
      expect(persistLastSeen).not.toHaveBeenCalled();
    });

    it("releases it once already resolved, writing nothing at all", async () => {
      expect(await run({ firstRunVersion: "3.0.0" })).toBe(false);

      expect(persistFirstRun).not.toHaveBeenCalled();
      expect(openGettingStarted).not.toHaveBeenCalled();
    });
  });
});
