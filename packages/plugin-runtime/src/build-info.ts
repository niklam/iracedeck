/**
 * The build facts (#1678): which plugin build, on which deck host, Windows and
 * Node, wrote a log or a snapshot.
 *
 * One reader for both consumers — the `Build:` info line the core phase writes
 * at start and at every iRacing session start, and the Telemetry Snapshot's
 * `environment` section — so a log and a snapshot from the same run can never
 * name different builds. No file path, keeping `state-sections.ts`' rule.
 *
 * Decision record: `docs/superpowers/specs/2026-11-10-issue-1678-version-in-every-log.md`.
 */
import {
  getPluginPlatform,
  getPluginVersion,
  type HostApplication,
  type IDeckPlatformAdapter,
} from "@iracedeck/deck-core";
import { arch, release } from "node:os";

/** What `readBuildInfo` returns: the six facts, in the order the `Build:` line names them. */
export type BuildInfo = {
  /** `getPluginVersion()`, e.g. "3.10.0". */
  pluginVersion: string;
  /** `getPluginPlatform()`, the plugin the build is for: "stream-deck", "mirabox", "ulanzi". */
  platform: string;
  /**
   * The deck host software and its version, as the adapter's
   * `hostApplication` reports it; `null` when the adapter cannot name its host
   * (its `undefined`), so the snapshot's key is always present and the line
   * leaves the host part out.
   */
  hostApplication: HostApplication | null;
  /** `os.release()`, the Windows version, whose build number tells Windows 10 from 11. */
  windows: string;
  /** `os.arch()`, e.g. "x64". */
  arch: string;
  /** `process.version` of the host's Node runtime. */
  node: string;
};

/**
 * Reads the build facts now. Needs `initPluginConfig` to have run (the plugin
 * version and platform throw before it); everything else is read live.
 */
export function readBuildInfo(adapter: Pick<IDeckPlatformAdapter, "hostApplication">): BuildInfo {
  return {
    pluginVersion: getPluginVersion(),
    platform: getPluginPlatform(),
    hostApplication: adapter.hostApplication ?? null,
    windows: release(),
    arch: arch(),
    node: process.version,
  };
}

/**
 * The `Build:` log line, e.g.
 * `Build: iRaceDeck 3.10.0 (stream-deck), Stream Deck 7.1.0, Windows 10.0.26300 x64, Node v24.16.0`.
 * It writes what it has and nothing it does not: a host with no version is its
 * name alone (`UlanziStudio`), and no host leaves the host part out entirely.
 */
export function formatBuildLine(info: BuildInfo): string {
  const parts = [`iRaceDeck ${info.pluginVersion} (${info.platform})`];

  if (info.hostApplication) {
    const { name, version } = info.hostApplication;
    parts.push(version ? `${name} ${version}` : name);
  }

  parts.push(`Windows ${info.windows} ${info.arch}`, `Node ${info.node}`);

  return `Build: ${parts.join(", ")}`;
}
