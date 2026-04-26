/**
 * In-memory platform adapter for the scenario harness.
 *
 * The harness needs `@iracedeck/deck-core`'s global-settings pipeline so the
 * audio-scenarios package reads settings through production code paths
 * (`getGlobalSettings()`, `resolveActiveRaceEngineerVoice()`, etc.). The
 * real `ElgatoPlatformAdapter` and `VSDPlatformAdapter` are tied to their
 * device SDKs, so we provide a minimal adapter whose only meaningful
 * behaviour is the global-settings hooks. Everything else on the
 * `IDeckPlatformAdapter` surface is a safe noop — the harness never
 * registers actions and never calls `connect()`, so those code paths are
 * unreachable in practice.
 */
import type { IDeckActionHandler, IDeckPlatformAdapter } from "@iracedeck/deck-core";
import { createConsoleLogger, type ILogger, LogLevel } from "@iracedeck/logger";

type GlobalSettingsListener = (settings: unknown) => void;

export class MockPlatformAdapter implements IDeckPlatformAdapter {
  private settings: Record<string, unknown> = {};
  private listeners: Set<GlobalSettingsListener> = new Set();
  private readonly rootLogger: ILogger;

  constructor(rootLogger?: ILogger) {
    this.rootLogger = rootLogger ?? createConsoleLogger("ScenarioHarness", LogLevel.Debug);
  }

  // ── Global settings (the part scenarios actually read through) ─────────────

  onDidReceiveGlobalSettings(callback: GlobalSettingsListener): void {
    this.listeners.add(callback);
  }

  /**
   * Mirror Stream Deck's behaviour: requesting settings causes the host to
   * deliver the current value via the `onDidReceiveGlobalSettings`
   * callback. Fired synchronously here — `initGlobalSettings()` calls this
   * during initialization, immediately after registering its listener.
   */
  getGlobalSettings(): void {
    const snapshot = this.settings;

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  setGlobalSettings(settings: Record<string, unknown>): void {
    this.settings = { ...settings };
    const snapshot = this.settings;

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /** Read the in-memory store directly. Used by the harness's own UI/state layer. */
  readSettings(): Record<string, unknown> {
    return this.settings;
  }

  // ── Logger factory ─────────────────────────────────────────────────────────

  createLogger(scope: string): ILogger {
    return this.rootLogger.createScope(scope);
  }

  // ── No-op stubs ────────────────────────────────────────────────────────────
  // The harness never registers actions and never connects to a device. These
  // exist so the adapter conforms to `IDeckPlatformAdapter` and so any
  // best-effort calls from deck-core internals (or future additions) don't
  // crash the dev tool.

  onApplicationDidLaunch(_callback: (application: string) => void): void {
    // intentionally unused
  }

  onApplicationDidTerminate(_callback: (application: string) => void): void {
    // intentionally unused
  }

  onPropertyInspectorDidAppear(_callback: () => void): void {
    // intentionally unused
  }

  registerAction(_uuid: string, _handler: IDeckActionHandler): void {
    // intentionally unused
  }

  onKeyDown(_callback: () => void): void {
    // intentionally unused
  }

  onDialDown(_callback: () => void): void {
    // intentionally unused
  }

  onDialRotate(_callback: () => void): void {
    // intentionally unused
  }

  connect(): void {
    // intentionally unused
  }
}
