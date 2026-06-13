import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { buildChangelogUrl, CHANGELOG_BASE_URL, runVersionCheck, shouldOpenChangelog } from "./version-check.js";

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
});
