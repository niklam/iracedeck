/**
 * Test-only host for the bootstrap's phases (#1349): a temp `<plugin>/bin`, an
 * adapter and an optional extension whose calls land in the recorder's
 * `callLog`, so a phase's order assertions see the host's calls interleaved
 * with its collaborators'.
 */
import type { IDeckPlatformAdapter, LogLocation } from "@iracedeck/deck-core";
import { silentLogger } from "@iracedeck/logger";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginExtension, PluginHost } from "../types.js";
import { callLog } from "./recorder.js";

/** A `<plugin>/bin` with a minimal `config.json`. */
export function createTempBinDir(): string {
  const binDir = mkdtempSync(join(tmpdir(), "plugin-runtime-"));

  writeFileSync(join(binDir, "config.json"), JSON.stringify({ version: "0.0.0-test", platform: "stream-deck" }));

  return binDir;
}

export interface FakeAdapter extends IDeckPlatformAdapter {
  /** The UUIDs `registerAction` received, in order. */
  readonly registered: string[];
  /** Every `onOpenSettingsRequest` listener, to fire in a test. */
  readonly openSettingsListeners: (() => void)[];
}

/**
 * An adapter whose every call lands in `callLog` as `adapter.<method>`, except
 * `createLogger` (returns the silent logger), `switchToProfile` and `openUrl`.
 * Passing `undefined` selects the default location; for an adapter WITHOUT a
 * log location build `{ ...createFakeAdapter(), logLocation: undefined }`.
 */
export function createFakeAdapter(
  logLocation: LogLocation | undefined = { kind: "daily", dir: tmpdir() },
): FakeAdapter {
  const registered: string[] = [];
  const openSettingsListeners: (() => void)[] = [];
  const record = (method: string) => (): void => {
    callLog.push(`adapter.${method}`);
  };

  return {
    registered,
    openSettingsListeners,
    logLocation,
    onDidReceiveGlobalSettings: record("onDidReceiveGlobalSettings"),
    getGlobalSettings: record("getGlobalSettings"),
    setGlobalSettings: record("setGlobalSettings"),
    onApplicationDidLaunch: record("onApplicationDidLaunch"),
    onApplicationDidTerminate: record("onApplicationDidTerminate"),
    onPropertyInspectorDidAppear: record("onPropertyInspectorDidAppear"),
    createLogger: () => silentLogger,
    registerAction: (uuid: string) => {
      callLog.push("adapter.registerAction");
      registered.push(uuid);
    },
    onKeyDown: record("onKeyDown"),
    onDialDown: record("onDialDown"),
    onDialRotate: record("onDialRotate"),
    connect: record("connect"),
    switchToProfile: async () => undefined,
    openUrl: async () => undefined,
    onOpenSettingsRequest: (listener: () => void) => {
      callLog.push("adapter.onOpenSettingsRequest");
      openSettingsListeners.push(listener);
    },
    setLogLevel: record("setLogLevel"),
  };
}

/** An extension whose every member lands in `callLog` as `extension.<member>`. */
export function createFakeExtension(extraUuids: readonly string[] = ["sd.only"]): PluginExtension {
  return {
    extraActions: extraUuids.map((uuid) => ({ uuid, scope: uuid, create: () => ({}) })),
    getConnectedDeviceType: () => {
      callLog.push("extension.getConnectedDeviceType");

      return 7;
    },
    switchProfile: () => {
      callLog.push("extension.switchProfile");
    },
    start: () => {
      callLog.push("extension.start");
    },
    refreshDevices: () => {
      callLog.push("extension.refreshDevices");
    },
  };
}

/** A host over a fresh temp bin dir and a fake adapter, with `extension` when given. */
export function createHost(
  extension?: PluginExtension,
  logLocation?: LogLocation,
): PluginHost & { adapter: FakeAdapter } {
  return { adapter: createFakeAdapter(logLocation), binDir: createTempBinDir(), ...(extension ? { extension } : {}) };
}
