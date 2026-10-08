/**
 * Test-only host for the bootstrap's phases (#1349): a temp `<plugin>/bin`, an
 * adapter and an optional extension whose calls land in the recorder's
 * `callLog`, so a phase's order assertions see the host's calls interleaved
 * with its collaborators'.
 *
 * Every test file that builds a host removes its temp bin dirs with
 * `afterAll(() => cleanupTempBinDirs())`.
 */
import type { LogLocation } from "@iracedeck/app-constants";
import type { IDeckPlatformAdapter } from "@iracedeck/deck-core";
import { silentLogger } from "@iracedeck/logger";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginExtension, PluginHost } from "../types.js";
import { callLog } from "./recorder.js";

const tempBinDirs: string[] = [];

/** A `<plugin>/bin` with a minimal `config.json`, removed by `cleanupTempBinDirs`. */
export function createTempBinDir(): string {
  const binDir = mkdtempSync(join(tmpdir(), "plugin-runtime-"));

  tempBinDirs.push(binDir);
  writeFileSync(join(binDir, "config.json"), JSON.stringify({ version: "0.0.0-test", platform: "stream-deck" }));

  return binDir;
}

/** Remove every bin dir `createTempBinDir` made in this test file. Call from `afterAll`. */
export function cleanupTempBinDirs(): void {
  for (const dir of tempBinDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FakeAdapter extends IDeckPlatformAdapter {
  /** The UUIDs `registerAction` received, in order. */
  readonly registered: string[];
  /** The scope of every `createLogger` call, in order. Kept out of `callLog`, so order lists stay about calls. */
  readonly scopes: string[];
  /** Every `onOpenSettingsRequest` listener, to fire in a test. */
  readonly openSettingsListeners: (() => void)[];
  /** Every `onKeyDown` listener, to fire in a test. */
  readonly keyDownListeners: (() => void)[];
  /** Every `onDialDown` listener, to fire in a test. */
  readonly dialDownListeners: (() => void)[];
  /** Every `onDialRotate` listener, to fire in a test. */
  readonly dialRotateListeners: (() => void)[];
  /** Every `onPropertyInspectorDidAppear` listener, to fire in a test. */
  readonly propertyInspectorDidAppearListeners: (() => void)[];
}

/**
 * An adapter whose every call lands in `callLog` as `adapter.<method>`, except
 * `createLogger` (returns the silent logger and records its scope in `scopes`),
 * `switchToProfile` and `openUrl`. The five listener subscriptions also keep
 * their listener, to fire in a test. Passing `undefined` selects the default
 * location; for an adapter WITHOUT a log location build
 * `{ ...createFakeAdapter(), logLocation: undefined }`.
 */
export function createFakeAdapter(
  logLocation: LogLocation | undefined = { kind: "daily", dir: tmpdir() },
): FakeAdapter {
  const registered: string[] = [];
  const scopes: string[] = [];
  const openSettingsListeners: (() => void)[] = [];
  const keyDownListeners: (() => void)[] = [];
  const dialDownListeners: (() => void)[] = [];
  const dialRotateListeners: (() => void)[] = [];
  const propertyInspectorDidAppearListeners: (() => void)[] = [];
  const record = (method: string) => (): void => {
    callLog.push(`adapter.${method}`);
  };
  const keep =
    (method: string, listeners: (() => void)[]) =>
    (listener: () => void): void => {
      callLog.push(`adapter.${method}`);
      listeners.push(listener);
    };

  return {
    registered,
    scopes,
    openSettingsListeners,
    keyDownListeners,
    dialDownListeners,
    dialRotateListeners,
    propertyInspectorDidAppearListeners,
    logLocation,
    onDidReceiveGlobalSettings: record("onDidReceiveGlobalSettings"),
    getGlobalSettings: record("getGlobalSettings"),
    setGlobalSettings: record("setGlobalSettings"),
    onApplicationDidLaunch: record("onApplicationDidLaunch"),
    onApplicationDidTerminate: record("onApplicationDidTerminate"),
    onPropertyInspectorDidAppear: keep("onPropertyInspectorDidAppear", propertyInspectorDidAppearListeners),
    createLogger: (scope: string) => {
      scopes.push(scope);

      return silentLogger;
    },
    registerAction: (uuid: string) => {
      callLog.push("adapter.registerAction");
      registered.push(uuid);
    },
    onKeyDown: keep("onKeyDown", keyDownListeners),
    onDialDown: keep("onDialDown", dialDownListeners),
    onDialRotate: keep("onDialRotate", dialRotateListeners),
    connect: record("connect"),
    switchToProfile: async () => undefined,
    openUrl: async () => undefined,
    onOpenSettingsRequest: keep("onOpenSettingsRequest", openSettingsListeners),
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
