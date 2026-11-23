import { arch, release } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type BuildInfo, formatBuildLine, readBuildInfo } from "./build-info.js";

// The plugin version and platform come from the bin dir's `config.json`
// through deck-core; the rest is read live from Node.
const config = vi.hoisted(() => ({ version: "3.10.0", platform: "stream-deck" }));

vi.mock("@iracedeck/deck-core", () => ({
  getPluginVersion: () => config.version,
  getPluginPlatform: () => config.platform,
}));

/** A build line's facts, with the host and the rest overridable per case. */
function info(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    pluginVersion: "3.10.0",
    platform: "stream-deck",
    hostApplication: { name: "Stream Deck", version: "7.1.0" },
    windows: "10.0.26300",
    arch: "x64",
    node: "v24.16.0",
    ...overrides,
  };
}

beforeEach(() => {
  config.version = "3.10.0";
  config.platform = "stream-deck";
});

describe("readBuildInfo (#1678)", () => {
  it("reads the plugin config, the adapter's host, Windows, the architecture and Node", () => {
    expect(readBuildInfo({ hostApplication: { name: "Stream Deck", version: "7.1.0" } })).toEqual({
      pluginVersion: "3.10.0",
      platform: "stream-deck",
      hostApplication: { name: "Stream Deck", version: "7.1.0" },
      windows: release(),
      arch: arch(),
      node: process.version,
    });
  });

  it("keeps a host whose version is null", () => {
    config.platform = "ulanzi";

    expect(readBuildInfo({ hostApplication: { name: "UlanziStudio", version: null } })).toMatchObject({
      platform: "ulanzi",
      hostApplication: { name: "UlanziStudio", version: null },
    });
  });

  it("gives a null host for an adapter that cannot name one, so the snapshot key stays present", () => {
    const read = readBuildInfo({ hostApplication: undefined });

    expect(read.hostApplication).toBeNull();
    expect(Object.keys(read)).toContain("hostApplication");
  });

  it("reads the plugin config at each call, not once", () => {
    readBuildInfo({ hostApplication: undefined });
    config.version = "3.10.1";

    expect(readBuildInfo({ hostApplication: undefined }).pluginVersion).toBe("3.10.1");
  });
});

describe("formatBuildLine (#1678)", () => {
  it("writes every fact in the spec's order", () => {
    expect(formatBuildLine(info())).toBe(
      "iRaceDeck 3.10.0 (stream-deck), Stream Deck 7.1.0, Windows 10.0.26300 x64, Node v24.16.0",
    );
  });

  it("names a host with no version by its name alone", () => {
    expect(
      formatBuildLine(info({ platform: "ulanzi", hostApplication: { name: "UlanziStudio", version: null } })),
    ).toBe("iRaceDeck 3.10.0 (ulanzi), UlanziStudio, Windows 10.0.26300 x64, Node v24.16.0");
  });

  it("leaves the host part out entirely when there is no host, with no double comma", () => {
    const line = formatBuildLine(info({ hostApplication: null }));

    expect(line).toBe("iRaceDeck 3.10.0 (stream-deck), Windows 10.0.26300 x64, Node v24.16.0");
    expect(line).not.toContain(",,");
    expect(line).not.toContain(", ,");
  });

  it("writes a VSD Craft host with its version", () => {
    expect(
      formatBuildLine(info({ platform: "mirabox", hostApplication: { name: "VSD Craft", version: "3.10.188" } })),
    ).toBe("iRaceDeck 3.10.0 (mirabox), VSD Craft 3.10.188, Windows 10.0.26300 x64, Node v24.16.0");
  });

  it("formats what readBuildInfo reads, so the line names the running build", () => {
    expect(formatBuildLine(readBuildInfo({ hostApplication: { name: "Stream Deck", version: "7.1.0" } }))).toBe(
      `iRaceDeck 3.10.0 (stream-deck), Stream Deck 7.1.0, Windows ${release()} ${arch()}, Node ${process.version}`,
    );
  });
});
