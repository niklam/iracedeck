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
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { getBindingDispatcher } from "./binding-dispatcher.js";
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

// ─── Engine Implementation ──────────────────────────────────────────

class AutomationEngine implements IAutomationEngine {
  private logger: ILogger;
  private rules = new Map<string, InternalRuleState>();
  private subscriptionId = "automation-engine";
  private subscribed = false;

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
  }

  updateRule(ruleId: string, config: AutomationRuleConfig): void {
    const state = this.rules.get(ruleId);

    if (!state) {
      this.registerRule(ruleId, config);

      return;
    }

    state.config = config;

    if (state.active) {
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

    this.ensureSubscribed();
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

  // ─── Telemetry Subscription ─────────────────────────────────────

  private ensureSubscribed(): void {
    if (this.subscribed) return;

    const activeCount = this.getActiveRuleCount();

    if (activeCount === 0) return;

    getController().subscribe(this.subscriptionId, (telemetry) => {
      this.onTelemetryUpdate(telemetry);
    });

    this.subscribed = true;
    this.logger.debug("Subscribed to telemetry");
  }

  private maybeUnsubscribe(): void {
    if (!this.subscribed) return;

    const activeCount = this.getActiveRuleCount();

    if (activeCount > 0) return;

    getController().unsubscribe(this.subscriptionId);
    this.subscribed = false;
    this.logger.debug("Unsubscribed from telemetry");
  }

  private getActiveRuleCount(): number {
    let count = 0;

    for (const state of this.rules.values()) {
      if (state.active) count++;
    }

    return count;
  }

  // ─── Telemetry Processing ───────────────────────────────────────

  private onTelemetryUpdate(telemetry: TelemetryData | null): void {
    if (!telemetry) return;

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

    // Detect new lap (LapCompleted incremented)
    if (lapCompleted !== state.prevLapCompleted) {
      state.firedThresholds.clear();
      state.prevLapCompleted = lapCompleted;
    }

    // Compute thresholds: [0/N, 1/N, ..., (N-1)/N]
    const prevPct = state.prevLapDistPct;
    const currPct = lapDistPct;

    for (let i = 0; i < timesPerLap; i++) {
      const threshold = i / timesPerLap;

      if (state.firedThresholds.has(i)) continue;

      if (this.crossedThreshold(prevPct, currPct, threshold)) {
        state.firedThresholds.add(i);
        this.fireCommand(ruleId, state, telemetry);
      }
    }

    state.prevLapDistPct = lapDistPct;
  }

  /**
   * Check if the track position crossed a threshold between prev and curr.
   * Handles wrapping (when lap resets from ~1.0 to ~0.0).
   * LapDistPct is 0.0–1.0 (despite docs saying %, the actual values are fractional).
   */
  private crossedThreshold(prev: number, curr: number, threshold: number): boolean {
    if (prev <= curr) {
      // Normal forward movement: prev=0.3, curr=0.5, threshold=0.4 → crossed
      return prev < threshold && curr >= threshold;
    }

    // Wrapping: prev=0.95, curr=0.05
    // Check if threshold is in the range [prev, 1.0) or [0.0, curr]
    return prev < threshold || curr >= threshold;
  }

  // ─── Pit Boundary Trigger ──────────────────────────────────────

  private evaluatePitBoundaryTrigger(ruleId: string, state: InternalRuleState, telemetry: TelemetryData): void {
    const trackSurface = telemetry.PlayerTrackSurface;
    const onPitRoad = telemetry.OnPitRoad;

    // First tick: seed previous values
    if (state.prevTrackSurface === null) {
      state.prevTrackSurface = trackSurface ?? null;
      state.prevOnPitRoad = onPitRoad ?? null;

      return;
    }

    // Approach detection: PlayerTrackSurface transitions TO AproachingPits
    if (
      state.config.enableOnApproach &&
      trackSurface !== undefined &&
      trackSurface === TrkLoc.AproachingPits &&
      state.prevTrackSurface !== TrkLoc.AproachingPits
    ) {
      this.logger.info("Pit approach detected");
      this.fireCommand(ruleId, state, telemetry);
    }

    // Exit detection: OnPitRoad transitions true → false
    if (state.config.disableOnExit && onPitRoad === false && state.prevOnPitRoad === true) {
      this.logger.info("Pit exit detected");
      this.fireCommand(ruleId, state, telemetry);
    }

    state.prevTrackSurface = trackSurface ?? state.prevTrackSurface;
    state.prevOnPitRoad = onPitRoad ?? state.prevOnPitRoad;
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
    state.fireCount++;
    state.lastFiredAt = telemetry.SessionTime ?? state.lastFiredAt;
    const bindingKey = COMMAND_BINDING_KEYS[state.config.command];

    this.logger.info(`Firing command: ${state.config.command}`);
    this.logger.debug(`Rule: ${ruleId}, binding: ${bindingKey}, count: ${state.fireCount}`);

    if (state.config.command === "headlight-flash") {
      void this.executeFlashSequence(ruleId, state, bindingKey);
    } else {
      void getBindingDispatcher()
        .tap(bindingKey)
        .catch((err) => this.logger.error(`Command dispatch failed: ${err}`));
    }
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

        // Gap between flashes (skip gap after last flash)
        if (i < flashCount - 1) {
          await this.delay(flashDuration, abortController.signal);
        }
      }
    } catch {
      // Aborted or error — ensure binding is released
      await dispatcher.release(ruleId).catch(() => {});
    } finally {
      state.flashInProgress = false;
      state.flashAbortController = null;
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Aborted"));

        return;
      }

      const timer = setTimeout(resolve, ms);

      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
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
