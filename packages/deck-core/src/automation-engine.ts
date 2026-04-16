/**
 * Automation Engine Singleton
 *
 * Background service that executes car control commands based on configurable
 * telemetry triggers. Runs independently of Stream Deck action visibility —
 * rules persist across page switches.
 *
 * Trigger types:
 * - Lap-based: fire at evenly-spaced track positions (LapDistPct)
 * - Pit boundary: fire on pit approach (PlayerTrackSurface) or exit (OnPitRoad)
 * - Interval: fire every N seconds (SessionTime)
 *
 * Commands are dispatched via the BindingDispatcher using existing global key bindings.
 *
 * Usage:
 * 1. Call initializeAutomationEngine() once at plugin startup (after initializeBindingDispatcher)
 * 2. Use getAutomationEngine() in action code to register/activate rules
 */
import { EngineWarnings, hasFlag, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { getBindingDispatcher } from "./binding-dispatcher.js";
import { getGlobalSettings } from "./global-settings.js";
import { parseBinding } from "./key-binding-utils.js";
import { getController } from "./sdk-singleton.js";

// ─── Types ───────────────────────────────────────────────────────────

export type AutomationCommand = "tear-off-visor" | "pit-limiter" | "headlight-flash" | "trigger-wipers";

export type AutomationTrigger = "lap" | "pit-boundary" | "interval";

export interface AutomationRuleConfig {
  command: AutomationCommand;
  trigger: AutomationTrigger;
  timesPerLap: number;
  intervalSeconds: number;
  enableOnApproach: boolean;
  disableOnExit: boolean;
  flashCount: number;
  flashDuration: number;
}

export interface AutomationRuleState {
  active: boolean;
  lastFiredAt: number | null;
  fireCount: number;
}

export interface IAutomationEngine {
  registerRule(ruleId: string, config: AutomationRuleConfig): void;
  updateRule(ruleId: string, config: AutomationRuleConfig): void;
  removeRule(ruleId: string): void;
  activateRule(ruleId: string): void;
  deactivateRule(ruleId: string): void;
  getRuleState(ruleId: string): AutomationRuleState | undefined;
  isRuleActive(ruleId: string): boolean;
  /** True when trigger evaluation is suppressed (disconnected, off-track, or replay). */
  isPaused(): boolean;
  /** Subscribe to active/paused transitions so consumers can refresh their UI. Returns an unsubscribe function. */
  onStateChange(listener: () => void): () => void;
}

// ─── Command → Binding Key Mapping ──────────────────────────────────

const COMMAND_BINDING_KEYS: Record<AutomationCommand, string> = {
  "tear-off-visor": "carControlTearOffVisor",
  "pit-limiter": "carControlPitSpeedLimiter",
  "headlight-flash": "carControlHeadlightFlash",
  "trigger-wipers": "cockpitMiscTriggerWipers",
};

// ─── Internal Rule State ────────────────────────────────────────────

interface InternalRuleState {
  config: AutomationRuleConfig;
  active: boolean;
  lastFiredAt: number | null;
  fireCount: number;
  // Lap trigger state
  prevLapDistPct: number | null;
  prevLapCompleted: number | null;
  firedThresholds: Set<number>;
  // Pit boundary state
  prevTrackSurface: number | null;
  prevOnPitRoad: boolean | null;
  // Flash sequence state
  flashInProgress: boolean;
  flashAbortController: AbortController | null;
}

function createInternalState(config: AutomationRuleConfig): InternalRuleState {
  return {
    config,
    active: false,
    lastFiredAt: null,
    fireCount: 0,
    prevLapDistPct: null,
    prevLapCompleted: null,
    firedThresholds: new Set(),
    prevTrackSurface: null,
    prevOnPitRoad: null,
    flashInProgress: false,
    flashAbortController: null,
  };
}

function resetTriggerState(state: InternalRuleState): void {
  state.lastFiredAt = null;
  state.fireCount = 0;
  state.prevLapDistPct = null;
  state.prevLapCompleted = null;
  state.firedThresholds.clear();
  state.prevTrackSurface = null;
  state.prevOnPitRoad = null;
}

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof AbortError || (err instanceof Error && err.name === "AbortError");
}

/** True when iRacing reports the pit speed limiter is engaged. */
function isPitLimiterActive(telemetry: TelemetryData): boolean {
  if (telemetry.EngineWarnings === undefined) return false;

  return hasFlag(telemetry.EngineWarnings, EngineWarnings.PitSpeedLimiter);
}

// ─── Engine Implementation ──────────────────────────────────────────

class AutomationEngine implements IAutomationEngine {
  private logger: ILogger;
  private rules = new Map<string, InternalRuleState>();
  private subscriptionId = "automation-engine";
  private subscribed = false;
  /**
   * Pauses trigger evaluation when disconnected, off-track, or watching replay.
   * Defaults to true so that the UI renders "N/A" before any telemetry has arrived
   * (e.g. plugin starts before iRacing is running).
   */
  private paused = true;
  private stateListeners = new Set<() => void>();

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  registerRule(ruleId: string, config: AutomationRuleConfig): void {
    if (this.rules.has(ruleId)) {
      this.updateRule(ruleId, config);

      return;
    }

    this.rules.set(ruleId, createInternalState(config));
    this.logger.debug(`Rule registered: ${ruleId}`);

    // Subscribe to telemetry the moment any rule exists — we need connection/track/replay
    // state to render "AUTO N/A" correctly even when no rule has been activated yet.
    this.ensureSubscribed();
  }

  updateRule(ruleId: string, config: AutomationRuleConfig): void {
    const state = this.rules.get(ruleId);

    if (!state) {
      this.registerRule(ruleId, config);

      return;
    }

    state.config = config;

    if (state.active) {
      // Abort any flash sequence using the previous config so the new config takes effect cleanly.
      if (state.flashAbortController) {
        state.flashAbortController.abort();
        state.flashAbortController = null;
        state.flashInProgress = false;
      }

      resetTriggerState(state);
    }

    this.logger.debug(`Rule updated: ${ruleId}`);
  }

  removeRule(ruleId: string): void {
    const state = this.rules.get(ruleId);

    if (!state) return;

    if (state.active) {
      this.deactivateRule(ruleId);
    }

    this.rules.delete(ruleId);
    this.logger.debug(`Rule removed: ${ruleId}`);

    this.maybeUnsubscribe();
  }

  activateRule(ruleId: string): void {
    const state = this.rules.get(ruleId);

    if (!state) {
      this.logger.warn(`Cannot activate unknown rule: ${ruleId}`);

      return;
    }

    if (state.active) return;

    state.active = true;
    resetTriggerState(state);
    this.logger.info(`Rule activated: ${ruleId}`);
    this.logger.debug(`Config: command=${state.config.command}, trigger=${state.config.trigger}`);

    this.warnIfBindingMissing(ruleId, state.config.command);
    this.ensureSubscribed();
    this.notifyStateChange();
  }

  /** Warn (once per activate) if the command's binding has not been configured in global settings. */
  private warnIfBindingMissing(ruleId: string, command: AutomationCommand): void {
    const bindingKey = COMMAND_BINDING_KEYS[command];
    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[bindingKey]);

    if (binding) return;

    this.logger.warn(`Rule activated but no binding configured for ${bindingKey} — commands will no-op until set`);
    this.logger.debug(`Rule: ${ruleId}, command: ${command}`);
  }

  deactivateRule(ruleId: string): void {
    const state = this.rules.get(ruleId);

    if (!state) return;

    if (!state.active) return;

    state.active = false;

    // Abort any in-progress flash sequence
    if (state.flashAbortController) {
      state.flashAbortController.abort();
      state.flashAbortController = null;
      state.flashInProgress = false;
    }

    // Release any held binding
    void getBindingDispatcher()
      .release(ruleId)
      .catch((err) => this.logger.error(`Failed to release binding on deactivate: ${err}`));

    this.logger.info(`Rule deactivated: ${ruleId}`);

    this.maybeUnsubscribe();
    this.notifyStateChange();
  }

  getRuleState(ruleId: string): AutomationRuleState | undefined {
    const state = this.rules.get(ruleId);

    if (!state) return undefined;

    return {
      active: state.active,
      lastFiredAt: state.lastFiredAt,
      fireCount: state.fireCount,
    };
  }

  isRuleActive(ruleId: string): boolean {
    return this.rules.get(ruleId)?.active ?? false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private notifyStateChange(): void {
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch (err) {
        this.logger.error(`State-change listener threw: ${err}`);
      }
    }
  }

  // ─── Telemetry Subscription ─────────────────────────────────────

  private ensureSubscribed(): void {
    if (this.subscribed) return;

    if (this.rules.size === 0) return;

    getController().subscribe(this.subscriptionId, (telemetry, isConnected) => {
      this.onTelemetryUpdate(telemetry, isConnected);
    });

    this.subscribed = true;
    this.logger.debug("Subscribed to telemetry");
  }

  private maybeUnsubscribe(): void {
    if (!this.subscribed) return;

    // Keep the subscription alive as long as any rule is registered (even inactive) —
    // we need connection/track/replay state to keep the N/A indicator correct.
    if (this.rules.size > 0) return;

    getController().unsubscribe(this.subscriptionId);
    this.subscribed = false;
    this.paused = true;
    this.logger.debug("Unsubscribed from telemetry");
  }

  /** Reset trigger state for every active rule (used when pausing due to disconnect/off-track/replay). */
  private resetAllActiveRuleStates(): void {
    for (const state of this.rules.values()) {
      if (!state.active) continue;

      if (state.flashAbortController) {
        state.flashAbortController.abort();
        state.flashAbortController = null;
        state.flashInProgress = false;
      }

      resetTriggerState(state);
    }
  }

  private getActiveRuleCount(): number {
    let count = 0;

    for (const state of this.rules.values()) {
      if (state.active) count++;
    }

    return count;
  }

  // ─── Telemetry Processing ───────────────────────────────────────

  private onTelemetryUpdate(telemetry: TelemetryData | null, isConnected: boolean): void {
    // Pause trigger evaluation whenever the sim is disconnected, the player is not on track,
    // or a replay is playing. IsOnTrack/IsReplayPlaying are permissive: only an explicit
    // false/true suppresses evaluation — undefined means unknown and falls through so tests
    // and older telemetry schemas continue to work.
    const shouldPause =
      !isConnected || !telemetry || telemetry.IsOnTrack === false || telemetry.IsReplayPlaying === true;

    if (shouldPause) {
      if (!this.paused) {
        this.paused = true;
        this.logger.info("Automation paused");
        this.logger.debug(
          `Pause reason: isConnected=${isConnected}, IsOnTrack=${telemetry?.IsOnTrack}, IsReplayPlaying=${telemetry?.IsReplayPlaying}`,
        );
        this.resetAllActiveRuleStates();
        this.notifyStateChange();
      }

      return;
    }

    if (this.paused) {
      this.paused = false;
      this.logger.info("Automation resumed");
      this.notifyStateChange();
    }

    for (const [ruleId, state] of this.rules) {
      if (!state.active) continue;

      switch (state.config.trigger) {
        case "lap":
          this.evaluateLapTrigger(ruleId, state, telemetry);
          break;
        case "pit-boundary":
          this.evaluatePitBoundaryTrigger(ruleId, state, telemetry);
          break;
        case "interval":
          this.evaluateIntervalTrigger(ruleId, state, telemetry);
          break;
      }
    }
  }

  // ─── Lap Trigger ────────────────────────────────────────────────

  private evaluateLapTrigger(ruleId: string, state: InternalRuleState, telemetry: TelemetryData): void {
    const lapDistPct = telemetry.LapDistPct;
    const lapCompleted = telemetry.LapCompleted;

    if (lapDistPct === undefined || lapCompleted === undefined) return;

    const { timesPerLap } = state.config;

    // First tick after activation: seed previous values, don't fire
    if (state.prevLapDistPct === null || state.prevLapCompleted === null) {
      state.prevLapDistPct = lapDistPct;
      state.prevLapCompleted = lapCompleted;

      return;
    }

    const lapChanged = lapCompleted !== state.prevLapCompleted;

    if (lapChanged) {
      state.firedThresholds.clear();
      state.prevLapCompleted = lapCompleted;
    }

    const prevPct = state.prevLapDistPct;
    const currPct = lapDistPct;

    for (let i = 0; i < timesPerLap; i++) {
      const threshold = i / timesPerLap;

      if (state.firedThresholds.has(i)) continue;

      if (this.crossedThreshold(prevPct, currPct, threshold, lapChanged)) {
        state.firedThresholds.add(i);
        this.fireCommand(ruleId, state, telemetry);
      }
    }

    state.prevLapDistPct = lapDistPct;
  }

  /**
   * Check if the track position crossed a threshold between prev and curr.
   * LapDistPct is 0.0–1.0 (despite docs saying %, the actual values are fractional).
   * prev > curr only counts as a lap wrap when LapCompleted actually changed —
   * otherwise it's backwards motion (spin/off-track/teleport) and must not fire.
   */
  private crossedThreshold(prev: number, curr: number, threshold: number, lapChanged: boolean): boolean {
    if (prev <= curr) {
      return prev < threshold && curr >= threshold;
    }

    if (!lapChanged) return false;

    return prev < threshold || curr >= threshold;
  }

  // ─── Pit Boundary Trigger ──────────────────────────────────────

  private evaluatePitBoundaryTrigger(ruleId: string, state: InternalRuleState, telemetry: TelemetryData): void {
    const trackSurface = telemetry.PlayerTrackSurface;
    const onPitRoad = telemetry.OnPitRoad;

    if (state.prevTrackSurface === null) {
      state.prevTrackSurface = trackSurface ?? null;
      state.prevOnPitRoad = onPitRoad ?? null;

      return;
    }

    const approaching =
      state.config.enableOnApproach &&
      trackSurface !== undefined &&
      trackSurface === TrkLoc.AproachingPits &&
      state.prevTrackSurface !== TrkLoc.AproachingPits;

    const exiting = state.config.disableOnExit && onPitRoad === false && state.prevOnPitRoad === true;

    if (approaching) {
      if (this.shouldFirePitBoundary(state, telemetry, "approach")) {
        this.logger.info("Pit approach detected");
        this.fireCommand(ruleId, state, telemetry);
      }
    }

    if (exiting) {
      if (this.shouldFirePitBoundary(state, telemetry, "exit")) {
        this.logger.info("Pit exit detected");
        this.fireCommand(ruleId, state, telemetry);
      }
    }

    state.prevTrackSurface = trackSurface ?? state.prevTrackSurface;
    state.prevOnPitRoad = onPitRoad ?? state.prevOnPitRoad;
  }

  /**
   * State-aware gate for pit-boundary fires. Pit limiter is a toggle keybind, so blindly
   * firing at the boundary would flip a correctly-armed limiter off on approach, or flip
   * a correctly-disengaged limiter on at exit. Other commands (tear-off, wipers, etc.)
   * are one-shot and always fire.
   */
  private shouldFirePitBoundary(
    state: InternalRuleState,
    telemetry: TelemetryData,
    boundary: "approach" | "exit",
  ): boolean {
    if (state.config.command !== "pit-limiter") return true;

    const limiterActive = isPitLimiterActive(telemetry);

    if (boundary === "approach" && limiterActive) {
      this.logger.debug("Skipping approach fire: pit limiter already active");

      return false;
    }

    if (boundary === "exit" && !limiterActive) {
      this.logger.debug("Skipping exit fire: pit limiter already inactive");

      return false;
    }

    return true;
  }

  // ─── Interval Trigger ──────────────────────────────────────────

  private evaluateIntervalTrigger(ruleId: string, state: InternalRuleState, telemetry: TelemetryData): void {
    const sessionTime = telemetry.SessionTime;

    if (sessionTime === undefined) return;

    // First tick: seed lastFiredAt to current time
    if (state.lastFiredAt === null) {
      state.lastFiredAt = sessionTime;

      return;
    }

    if (sessionTime - state.lastFiredAt >= state.config.intervalSeconds) {
      state.lastFiredAt = sessionTime;
      this.fireCommand(ruleId, state, telemetry);
    }
  }

  // ─── Command Dispatch ──────────────────────────────────────────

  private fireCommand(ruleId: string, state: InternalRuleState, telemetry: TelemetryData): void {
    const bindingKey = COMMAND_BINDING_KEYS[state.config.command];

    // lastFiredAt must advance synchronously: interval triggers re-evaluate every tick and
    // would re-fire while a tap promise is still resolving if we waited for success.
    state.lastFiredAt = telemetry.SessionTime ?? state.lastFiredAt;

    this.logger.info(`Firing command: ${state.config.command}`);
    this.logger.debug(`Rule: ${ruleId}, binding: ${bindingKey}, attempt: ${state.fireCount + 1}`);

    if (state.config.command === "headlight-flash") {
      state.fireCount++;
      void this.executeFlashSequence(ruleId, state, bindingKey);

      return;
    }

    void getBindingDispatcher()
      .tap(bindingKey)
      .then(() => {
        state.fireCount++;
      })
      .catch((err) =>
        this.logger.error(`Command dispatch failed for rule ${ruleId} (${state.config.command}/${bindingKey}): ${err}`),
      );
  }

  private async executeFlashSequence(ruleId: string, state: InternalRuleState, bindingKey: string): Promise<void> {
    if (state.flashInProgress) return;

    state.flashInProgress = true;
    const abortController = new AbortController();
    state.flashAbortController = abortController;
    const { flashCount, flashDuration } = state.config;
    const dispatcher = getBindingDispatcher();

    try {
      for (let i = 0; i < flashCount; i++) {
        if (abortController.signal.aborted) break;

        await dispatcher.hold(ruleId, bindingKey);
        await this.delay(flashDuration, abortController.signal);

        if (abortController.signal.aborted) break;

        await dispatcher.release(ruleId);

        if (i < flashCount - 1) {
          await this.delay(flashDuration, abortController.signal);
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        this.logger.debug(`Flash sequence aborted for rule ${ruleId}`);
      } else {
        this.logger.error(`Flash sequence failed for rule ${ruleId} (${bindingKey}): ${err}`);
      }

      // Always attempt cleanup release, but log if cleanup itself fails — a stuck-held
      // binding (headlights/visor/wipers) is the worst-case failure mode for this engine.
      await dispatcher.release(ruleId).catch((relErr) => {
        this.logger.error(`Flash cleanup release failed for rule ${ruleId} (${bindingKey}): ${relErr}`);
      });
    } finally {
      state.flashInProgress = false;
      state.flashAbortController = null;
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortError());

        return;
      }

      const timer = setTimeout(resolve, ms);

      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new AbortError());
        },
        { once: true },
      );
    });
  }
}

// ─── Singleton Lifecycle ────────────────────────────────────────────

let engine: AutomationEngine | null = null;

export function initializeAutomationEngine(logger: ILogger = silentLogger): IAutomationEngine {
  if (engine) {
    throw new Error("AutomationEngine already initialized. initializeAutomationEngine() should only be called once.");
  }

  engine = new AutomationEngine(logger);
  logger.info("Automation engine initialized");

  return engine;
}

export function getAutomationEngine(): IAutomationEngine {
  if (!engine) {
    throw new Error(
      "AutomationEngine not initialized. Call initializeAutomationEngine() first in your plugin entry point.",
    );
  }

  return engine;
}

export function isAutomationEngineInitialized(): boolean {
  return engine !== null;
}

/**
 * Reset the automation engine singleton (for testing purposes only).
 * @internal
 */
export function _resetAutomationEngine(): void {
  engine = null;
}
