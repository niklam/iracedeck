import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  buildChangelogUrl,
  CHANGELOG_BASE_URL,
  type ChangelogNotificationPolicy,
  MONTHLY_WINDOW_MS,
  resolveChangelogDecision,
  runVersionCheck,
  shouldOpenChangelog,
} from "./version-check.js";

function stubLogger(): ILogger {
  const logger: ILogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(() => logger),
    createScope: vi.fn(() => logger),
  };

  return logger;
}

describe("shouldOpenChangelog", () => {
  it("returns false for a pre-release current version", () => {
    expect(shouldOpenChangelog("1.22.0-rc.1", "1.21.0")).toBe(false);
    expect(shouldOpenChangelog("1.22.0-dev.0", null)).toBe(false);
  });

  it("returns false for an invalid current version", () => {
    expect(shouldOpenChangelog("", "1.21.0")).toBe(false);
    expect(shouldOpenChangelog("abc", "1.21.0")).toBe(false);
  });

  it("returns true on first run regardless of lastSeen shape", () => {
    expect(shouldOpenChangelog("1.22.0", undefined)).toBe(true);
    expect(shouldOpenChangelog("1.22.0", null)).toBe(true);
    expect(shouldOpenChangelog("1.22.0", "")).toBe(true);
    expect(shouldOpenChangelog("1.22.0", "not-a-version")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(shouldOpenChangelog("1.22.0", "1.22.0")).toBe(false);
  });

  it("returns true for a newer stable version", () => {
    expect(shouldOpenChangelog("1.22.0", "1.21.0")).toBe(true);
  });

  it("returns false for a downgrade (older stable)", () => {
    expect(shouldOpenChangelog("1.21.0", "1.22.0")).toBe(false);
  });

  it("returns true when a stored pre-release precedes a stable current", () => {
    expect(shouldOpenChangelog("1.22.0", "1.22.0-rc.1")).toBe(true);
  });
});

describe("buildChangelogUrl", () => {
  it("includes the ecosystem parameter", () => {
    expect(buildChangelogUrl({ ecosystem: "stream-deck" })).toBe(`${CHANGELOG_BASE_URL}?ecosystem=stream-deck`);
  });

  it("includes the type parameter for a numeric deviceType", () => {
    expect(buildChangelogUrl({ ecosystem: "stream-deck", deviceType: 7 })).toBe(
      `${CHANGELOG_BASE_URL}?ecosystem=stream-deck&type=7`,
    );
  });

  it("includes the type parameter for a string deviceType", () => {
    expect(buildChangelogUrl({ ecosystem: "mirabox", deviceType: "n4" })).toBe(
      `${CHANGELOG_BASE_URL}?ecosystem=mirabox&type=n4`,
    );
  });

  it("omits the type parameter when deviceType is undefined", () => {
    expect(buildChangelogUrl({ ecosystem: "mirabox", deviceType: undefined })).toBe(
      `${CHANGELOG_BASE_URL}?ecosystem=mirabox`,
    );
  });

  it("omits the type parameter when deviceType is an empty string", () => {
    expect(buildChangelogUrl({ ecosystem: "mirabox", deviceType: "" })).toBe(`${CHANGELOG_BASE_URL}?ecosystem=mirabox`);
  });
});

describe("resolveChangelogDecision", () => {
  const now = 1_750_000_000_000;

  function decide(overrides: {
    currentVersion?: string;
    lastSeenVersion?: string | null;
    policy?: ChangelogNotificationPolicy;
    lastOpenedAt?: number | null;
  }) {
    return resolveChangelogDecision({
      currentVersion: "1.24.0",
      lastSeenVersion: "1.23.0",
      policy: "always",
      now,
      ...overrides,
    });
  }

  it.each(["always", "features", "monthly", "never"] as const)(
    "returns skip for pre-release / invalid / equal / downgrade under %s",
    (policy) => {
      expect(decide({ policy, currentVersion: "1.24.0-rc.1" })).toBe("skip");
      expect(decide({ policy, currentVersion: "abc" })).toBe("skip");
      expect(decide({ policy, currentVersion: "1.23.0" })).toBe("skip");
      expect(decide({ policy, currentVersion: "1.22.0" })).toBe("skip");
    },
  );

  describe("always", () => {
    it("opens for a newer stable version", () => {
      expect(decide({})).toBe("open");
    });

    it("opens on first run", () => {
      expect(decide({ lastSeenVersion: null })).toBe("open");
    });
  });

  describe("never", () => {
    it("tracks silently for a newer stable version", () => {
      expect(decide({ policy: "never" })).toBe("track-silently");
    });

    it("tracks silently on first run", () => {
      expect(decide({ policy: "never", lastSeenVersion: null })).toBe("track-silently");
    });
  });

  describe("features", () => {
    it("opens for a minor bump", () => {
      expect(decide({ policy: "features" })).toBe("open");
    });

    it("opens for a major bump", () => {
      expect(decide({ policy: "features", currentVersion: "2.0.0" })).toBe("open");
    });

    it("tracks silently for a patch bump", () => {
      expect(decide({ policy: "features", currentVersion: "1.23.1" })).toBe("track-silently");
    });

    it("opens on first run", () => {
      expect(decide({ policy: "features", lastSeenVersion: null })).toBe("open");
    });

    it("tracks silently when a stored pre-release precedes the same stable triple", () => {
      expect(decide({ policy: "features", currentVersion: "1.24.0", lastSeenVersion: "1.24.0-rc.1" })).toBe(
        "track-silently",
      );
    });
  });

  describe("monthly", () => {
    it("opens when no last-opened timestamp exists", () => {
      expect(decide({ policy: "monthly" })).toBe("open");
    });

    it("defers while inside the window, leaving the version pending", () => {
      expect(decide({ policy: "monthly", lastOpenedAt: now - MONTHLY_WINDOW_MS + 1 })).toBe("defer");
      expect(decide({ policy: "monthly", lastOpenedAt: now - 1 })).toBe("defer");
    });

    it("opens exactly at the window boundary", () => {
      expect(decide({ policy: "monthly", lastOpenedAt: now - MONTHLY_WINDOW_MS })).toBe("open");
    });

    it("opens past the window", () => {
      expect(decide({ policy: "monthly", lastOpenedAt: now - MONTHLY_WINDOW_MS - 1 })).toBe("open");
    });

    it("treats an invalid timestamp as missing", () => {
      expect(decide({ policy: "monthly", lastOpenedAt: Number.NaN })).toBe("open");
    });
  });
});

describe("runVersionCheck", () => {
  let persist: Mock<(version: string) => void>;
  let openUrl: Mock<(url: string) => Promise<void>>;
  let logger: ILogger;

  beforeEach(() => {
    persist = vi.fn<(version: string) => void>();
    openUrl = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    logger = stubLogger();
  });

  it("persists the current version and opens the built URL when due", async () => {
    await runVersionCheck({
      currentVersion: "1.22.0",
      lastSeenVersion: "1.21.0",
      ecosystem: "stream-deck",
      deviceType: 7,
      persist,
      openUrl,
      logger,
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("1.22.0");
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(`${CHANGELOG_BASE_URL}?ecosystem=stream-deck&type=7`);
  });

  it("persists even when openUrl rejects, without throwing", async () => {
    openUrl = vi.fn<(url: string) => Promise<void>>().mockRejectedValue(new Error("boom"));

    await expect(
      runVersionCheck({
        currentVersion: "1.22.0",
        lastSeenVersion: "1.21.0",
        ecosystem: "stream-deck",
        persist,
        openUrl,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("1.22.0");
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("is fully inert for a pre-release current version", async () => {
    await runVersionCheck({
      currentVersion: "1.22.0-rc.1",
      lastSeenVersion: "1.21.0",
      ecosystem: "stream-deck",
      persist,
      openUrl,
      logger,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("is fully inert for a downgrade", async () => {
    await runVersionCheck({
      currentVersion: "1.21.0",
      lastSeenVersion: "1.22.0",
      ecosystem: "stream-deck",
      persist,
      openUrl,
      logger,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  describe("changelogNotification policy (issue #742)", () => {
    const now = 1_750_000_000_000;
    let persistOpenedAt: Mock<(timestamp: number) => void>;

    beforeEach(() => {
      persistOpenedAt = vi.fn<(timestamp: number) => void>();
    });

    it("never: records the version without opening", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "never",
        ecosystem: "stream-deck",
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.24.0");
      expect(openUrl).not.toHaveBeenCalled();
      expect(persistOpenedAt).not.toHaveBeenCalled();
    });

    it("features: a patch update records the version silently", async () => {
      await runVersionCheck({
        currentVersion: "1.23.1",
        lastSeenVersion: "1.23.0",
        policy: "features",
        ecosystem: "stream-deck",
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.23.1");
      expect(openUrl).not.toHaveBeenCalled();
      expect(persistOpenedAt).not.toHaveBeenCalled();
    });

    it("features: a minor update opens and stamps the timestamp", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "features",
        ecosystem: "stream-deck",
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.24.0");
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(persistOpenedAt).toHaveBeenCalledWith(now);
    });

    it("monthly: inside the window is fully inert so the version stays pending", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "monthly",
        lastOpenedAt: now - 1000,
        ecosystem: "stream-deck",
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
      expect(persistOpenedAt).not.toHaveBeenCalled();
    });

    it("monthly: past the window opens and stamps the timestamp", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "monthly",
        lastOpenedAt: now - MONTHLY_WINDOW_MS,
        ecosystem: "stream-deck",
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.24.0");
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(persistOpenedAt).toHaveBeenCalledWith(now);
    });

    it("defaults to always and stamps the timestamp when the delegate is provided", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        ecosystem: "stream-deck",
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(persistOpenedAt).toHaveBeenCalledWith(now);
    });

    it("opens fine without a persistOpenedAt delegate", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "always",
        ecosystem: "stream-deck",
        persist,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.24.0");
      expect(openUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe("sim-running gate (issue #870)", () => {
    const now = 1_750_000_000_000;
    let persistOpenedAt: Mock<(timestamp: number) => void>;

    beforeEach(() => {
      persistOpenedAt = vi.fn<(timestamp: number) => void>();
    });

    it("defers a due open while the sim is running: fully inert so the version stays pending", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        ecosystem: "stream-deck",
        isSimRunning: () => true,
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).not.toHaveBeenCalled();
      expect(persistOpenedAt).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("defers a monthly open past the window while the sim is running", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "monthly",
        lastOpenedAt: now - MONTHLY_WINDOW_MS - 1,
        ecosystem: "stream-deck",
        isSimRunning: () => true,
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).not.toHaveBeenCalled();
      expect(persistOpenedAt).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("opens normally when the delegate reports the sim is not running", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        ecosystem: "stream-deck",
        isSimRunning: () => false,
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.24.0");
      expect(persistOpenedAt).toHaveBeenCalledWith(now);
      expect(openUrl).toHaveBeenCalledTimes(1);
    });

    it("never: still records the version silently while the sim is running (nothing opens anyway)", async () => {
      await runVersionCheck({
        currentVersion: "1.24.0",
        lastSeenVersion: "1.23.0",
        policy: "never",
        ecosystem: "stream-deck",
        isSimRunning: () => true,
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.24.0");
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("features: a patch update still records silently while the sim is running", async () => {
      await runVersionCheck({
        currentVersion: "1.23.1",
        lastSeenVersion: "1.23.0",
        policy: "features",
        ecosystem: "stream-deck",
        isSimRunning: () => true,
        persist,
        persistOpenedAt,
        openUrl,
        logger,
        now,
      });

      expect(persist).toHaveBeenCalledWith("1.23.1");
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("does not consult the delegate when nothing is due", async () => {
      const isSimRunning = vi.fn(() => true);

      await runVersionCheck({
        currentVersion: "1.23.0",
        lastSeenVersion: "1.23.0",
        ecosystem: "stream-deck",
        isSimRunning,
        persist,
        openUrl,
        logger,
        now,
      });

      expect(isSimRunning).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
    });
  });
});
