import { EngineWarnings, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAutomationEngine,
  type AutomationRuleConfig,
  getAutomationEngine,
  initializeAutomationEngine,
} from "./automation-engine.js";

// ─── Mocks ──────────────────────────────────────────────────────────

const mockTap = vi.fn().mockResolvedValue(undefined);
const mockHold = vi.fn().mockResolvedValue(undefined);
const mockRelease = vi.fn().mockResolvedValue(undefined);
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

vi.mock("./binding-dispatcher.js", () => ({
  getBindingDispatcher: () => ({
    tap: mockTap,
    hold: mockHold,
    release: mockRelease,
  }),
}));

vi.mock("./sdk-singleton.js", () => ({
  getController: () => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

// ─── Helpers ────────────────────────────────────────────────────────

function defaultConfig(overrides: Partial<AutomationRuleConfig> = {}): AutomationRuleConfig {
  return {
    command: "tear-off-visor",
    trigger: "lap",
    timesPerLap: 1,
    intervalSeconds: 5,
    enableOnApproach: false,
    disableOnExit: false,
    flashCount: 1,
    flashDuration: 200,
    ...overrides,
  };
}

/** Simulate a telemetry callback — grabs the registered callback and calls it. */
function simulateTelemetry(telemetry: Partial<TelemetryData> | null, isConnected = true): void {
  const callback = mockSubscribe.mock.calls[mockSubscribe.mock.calls.length - 1]?.[1];

  expect(callback).toBeDefined();
  callback(telemetry as TelemetryData | null, isConnected);
}

describe("AutomationEngine", () => {
  beforeEach(() => {
    _resetAutomationEngine();
    vi.clearAllMocks();
  });

  // ─── Initialization ─────────────────────────────────────────────

  describe("initialization", () => {
    it("should initialize and return engine", () => {
      const engine = initializeAutomationEngine(mockLogger);

      expect(engine).toBeDefined();
    });

    it("should throw on double initialization", () => {
      initializeAutomationEngine(mockLogger);

      expect(() => initializeAutomationEngine(mockLogger)).toThrow("already initialized");
    });

    it("should throw on getAutomationEngine before init", () => {
      expect(() => getAutomationEngine()).toThrow("not initialized");
    });
  });

  // ─── Rule Lifecycle ─────────────────────────────────────────────

  describe("rule lifecycle", () => {
    it("should register and retrieve rule state", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      const state = engine.getRuleState("rule-1");

      expect(state).toEqual({ active: false, lastFiredAt: null, fireCount: 0 });
    });

    it("should return undefined for unknown rule", () => {
      const engine = initializeAutomationEngine(mockLogger);

      expect(engine.getRuleState("nonexistent")).toBeUndefined();
    });

    it("should activate and deactivate rule", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());

      engine.activateRule("rule-1");
      expect(engine.isRuleActive("rule-1")).toBe(true);

      engine.deactivateRule("rule-1");
      expect(engine.isRuleActive("rule-1")).toBe(false);
    });

    it("should subscribe to telemetry on first rule registration", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());

      expect(mockSubscribe).toHaveBeenCalledWith("automation-engine", expect.any(Function));
    });

    it("should not unsubscribe on deactivate (rule still registered)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      engine.activateRule("rule-1");
      engine.deactivateRule("rule-1");

      // Subscription stays alive so the UI can keep showing AUTO N/A when off-track.
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });

    it("should unsubscribe from telemetry when last rule is removed", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      engine.removeRule("rule-1");

      expect(mockUnsubscribe).toHaveBeenCalledWith("automation-engine");
    });

    it("should not unsubscribe when other rules are still registered", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      engine.registerRule("rule-2", defaultConfig());
      engine.removeRule("rule-1");

      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });

    it("should remove rule", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      engine.removeRule("rule-1");

      expect(engine.getRuleState("rule-1")).toBeUndefined();
    });

    it("should deactivate rule on removal", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      engine.activateRule("rule-1");
      engine.removeRule("rule-1");

      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });

  // ─── Pause State ────────────────────────────────────────────────

  describe("pause state (N/A visual)", () => {
    it("should default to paused before any telemetry arrives", () => {
      const engine = initializeAutomationEngine(mockLogger);

      expect(engine.isPaused()).toBe(true);
    });

    it("should clear paused on first valid telemetry", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());

      simulateTelemetry({ LapDistPct: 0.0, LapCompleted: 0 }, true);

      expect(engine.isPaused()).toBe(false);
    });

    it("should re-enter paused when telemetry reports disconnected", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      simulateTelemetry({ LapDistPct: 0.0, LapCompleted: 0 }, true);
      expect(engine.isPaused()).toBe(false);

      simulateTelemetry(null, false);
      expect(engine.isPaused()).toBe(true);
    });

    it("should stay paused when telemetry reports off-track", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());

      simulateTelemetry({ IsOnTrack: false }, true);

      expect(engine.isPaused()).toBe(true);
    });

    it("should stay paused when telemetry reports replay playing", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());

      simulateTelemetry({ IsReplayPlaying: true }, true);

      expect(engine.isPaused()).toBe(true);
    });

    it("should fire state-change listener on pause transitions", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      const listener = vi.fn();
      engine.onStateChange(listener);

      simulateTelemetry({ LapDistPct: 0.0, LapCompleted: 0 }, true);
      simulateTelemetry(null, false);

      // One resume, one pause.
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("should fire state-change listener on activate and deactivate", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      const listener = vi.fn();
      engine.onStateChange(listener);

      engine.activateRule("rule-1");
      engine.deactivateRule("rule-1");

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("should stop firing after unsubscribe", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig());
      const listener = vi.fn();
      const unsubscribe = engine.onStateChange(listener);
      unsubscribe();

      engine.activateRule("rule-1");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should not fire command when paused even if rule is active", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "interval", intervalSeconds: 1 }));
      engine.activateRule("rule-1");

      simulateTelemetry({ SessionTime: 0, IsReplayPlaying: true }, true);
      simulateTelemetry({ SessionTime: 5, IsReplayPlaying: true }, true);

      expect(mockTap).not.toHaveBeenCalled();
    });
  });

  // ─── Lap Trigger ────────────────────────────────────────────────

  describe("lap trigger", () => {
    it("should not fire on first telemetry tick (seeding)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 1 }));
      engine.activateRule("rule-1");

      simulateTelemetry({ LapDistPct: 0.5, LapCompleted: 0 });

      expect(mockTap).not.toHaveBeenCalled();
    });

    it("should fire when crossing threshold (1 time per lap at 0%)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 1 }));
      engine.activateRule("rule-1");

      // Seed
      simulateTelemetry({ LapDistPct: 0.95, LapCompleted: 0 });
      // Cross 0.0 threshold (wrap)
      simulateTelemetry({ LapDistPct: 0.05, LapCompleted: 1 });

      expect(mockTap).toHaveBeenCalledWith("carControlTearOffVisor");
    });

    it("should fire at evenly spaced positions (3 times per lap)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 3 }));
      engine.activateRule("rule-1");

      // Seed at 0%
      simulateTelemetry({ LapDistPct: 0.0, LapCompleted: 0 });
      // Thresholds: 0/3=0.0, 1/3≈0.333, 2/3≈0.667

      // Move past first threshold (should fire at 0.0 since we seeded at exactly 0.0 and it hasn't crossed yet)
      // Actually, 0.0 -> 0.1 crosses 0.0 threshold? No: prev=0.0, threshold=0.0, 0.0 < 0.0 is false
      // Threshold at exactly 0 is tricky — let's move through the lap normally

      // Cross 1/3 threshold
      simulateTelemetry({ LapDistPct: 0.35, LapCompleted: 0 });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // Cross 2/3 threshold
      simulateTelemetry({ LapDistPct: 0.7, LapCompleted: 0 });
      expect(mockTap).toHaveBeenCalledTimes(2);

      // No more thresholds until wrap
      simulateTelemetry({ LapDistPct: 0.9, LapCompleted: 0 });
      expect(mockTap).toHaveBeenCalledTimes(2);

      // Wrap to new lap — crosses 0.0 threshold
      simulateTelemetry({ LapDistPct: 0.05, LapCompleted: 1 });
      expect(mockTap).toHaveBeenCalledTimes(3);
    });

    it("should not double-fire on same threshold", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 2 }));
      engine.activateRule("rule-1");

      // Seed
      simulateTelemetry({ LapDistPct: 0.1, LapCompleted: 0 });
      // Cross 0.5 threshold
      simulateTelemetry({ LapDistPct: 0.55, LapCompleted: 0 });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // Stay past threshold
      simulateTelemetry({ LapDistPct: 0.6, LapCompleted: 0 });
      expect(mockTap).toHaveBeenCalledTimes(1);
    });

    it("should handle wrapping near start/finish", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 2 }));
      engine.activateRule("rule-1");

      // Seed at 80%
      simulateTelemetry({ LapDistPct: 0.8, LapCompleted: 0 });
      // Wrap: 0.8 -> 0.1, new lap. Thresholds: 0.0 and 0.5
      // Wrapping should fire the 0.0 threshold
      simulateTelemetry({ LapDistPct: 0.1, LapCompleted: 1 });
      expect(mockTap).toHaveBeenCalledTimes(1);
    });

    it("should skip telemetry without required fields", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 1 }));
      engine.activateRule("rule-1");

      simulateTelemetry({ LapDistPct: undefined, LapCompleted: undefined });
      expect(mockTap).not.toHaveBeenCalled();
    });

    it("should not fire on null telemetry", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "lap", timesPerLap: 1 }));
      engine.activateRule("rule-1");

      simulateTelemetry(null);
      expect(mockTap).not.toHaveBeenCalled();
    });
  });

  // ─── Pit Boundary Trigger ──────────────────────────────────────

  describe("pit boundary trigger", () => {
    it("should fire on pit approach transition", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({ trigger: "pit-boundary", enableOnApproach: true, command: "pit-limiter" }),
      );
      engine.activateRule("rule-1");

      // Seed: on track
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false });
      // Transition to approaching pits
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, OnPitRoad: false });

      expect(mockTap).toHaveBeenCalledWith("carControlPitSpeedLimiter");
    });

    it("should not fire when approach is disabled", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({ trigger: "pit-boundary", enableOnApproach: false, disableOnExit: true }),
      );
      engine.activateRule("rule-1");

      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false });
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, OnPitRoad: false });

      expect(mockTap).not.toHaveBeenCalled();
    });

    it("should fire on pit exit transition (OnPitRoad true→false)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({ trigger: "pit-boundary", disableOnExit: true, command: "pit-limiter" }),
      );
      engine.activateRule("rule-1");

      // Seed: on pit road, limiter ON (gating requires limiter to be active for exit to fire)
      simulateTelemetry({
        PlayerTrackSurface: TrkLoc.OnTrack,
        OnPitRoad: true,
        EngineWarnings: EngineWarnings.PitSpeedLimiter,
      });
      // Exit pit road, limiter still ON
      simulateTelemetry({
        PlayerTrackSurface: TrkLoc.OnTrack,
        OnPitRoad: false,
        EngineWarnings: EngineWarnings.PitSpeedLimiter,
      });

      expect(mockTap).toHaveBeenCalledWith("carControlPitSpeedLimiter");
    });

    it("should not fire on pit entry (OnPitRoad false→true) when only exit enabled", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "pit-boundary", disableOnExit: true }));
      engine.activateRule("rule-1");

      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false });
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: true });

      expect(mockTap).not.toHaveBeenCalled();
    });

    it("should fire once per approach (edge-detected)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "pit-boundary", enableOnApproach: true }));
      engine.activateRule("rule-1");

      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false });
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, OnPitRoad: false });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // Stay on approaching — should not fire again
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, OnPitRoad: false });
      expect(mockTap).toHaveBeenCalledTimes(1);
    });

    it("should fire both approach and exit when both enabled", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({ trigger: "pit-boundary", enableOnApproach: true, disableOnExit: true }),
      );
      engine.activateRule("rule-1");

      // Seed
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false });
      // Approach
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, OnPitRoad: false });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // On pit road
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.InPitStall, OnPitRoad: true });
      // Exit pit road
      simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false });
      expect(mockTap).toHaveBeenCalledTimes(2);
    });

    describe("pit limiter state-aware gating", () => {
      it("should skip approach fire when limiter is already active", () => {
        const engine = initializeAutomationEngine(mockLogger);
        engine.registerRule(
          "rule-1",
          defaultConfig({
            trigger: "pit-boundary",
            enableOnApproach: true,
            command: "pit-limiter",
          }),
        );
        engine.activateRule("rule-1");

        // Seed with limiter ON (e.g. driver manually armed it before approach)
        simulateTelemetry({
          PlayerTrackSurface: TrkLoc.OnTrack,
          OnPitRoad: false,
          EngineWarnings: EngineWarnings.PitSpeedLimiter,
        });
        // Transition to approaching pits with limiter still ON
        simulateTelemetry({
          PlayerTrackSurface: TrkLoc.AproachingPits,
          OnPitRoad: false,
          EngineWarnings: EngineWarnings.PitSpeedLimiter,
        });

        expect(mockTap).not.toHaveBeenCalled();
      });

      it("should fire approach when limiter is inactive", () => {
        const engine = initializeAutomationEngine(mockLogger);
        engine.registerRule(
          "rule-1",
          defaultConfig({
            trigger: "pit-boundary",
            enableOnApproach: true,
            command: "pit-limiter",
          }),
        );
        engine.activateRule("rule-1");

        simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false, EngineWarnings: 0 });
        simulateTelemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, OnPitRoad: false, EngineWarnings: 0 });

        expect(mockTap).toHaveBeenCalledWith("carControlPitSpeedLimiter");
      });

      it("should skip exit fire when limiter is already inactive", () => {
        const engine = initializeAutomationEngine(mockLogger);
        engine.registerRule(
          "rule-1",
          defaultConfig({
            trigger: "pit-boundary",
            disableOnExit: true,
            command: "pit-limiter",
          }),
        );
        engine.activateRule("rule-1");

        // Seed on pit road with limiter OFF (e.g. iRacing's auto-limiter already disabled it)
        simulateTelemetry({ PlayerTrackSurface: TrkLoc.InPitStall, OnPitRoad: true, EngineWarnings: 0 });
        // Exit pit road, limiter still OFF
        simulateTelemetry({ PlayerTrackSurface: TrkLoc.OnTrack, OnPitRoad: false, EngineWarnings: 0 });

        expect(mockTap).not.toHaveBeenCalled();
      });

      it("should fire exit when limiter is still active", () => {
        const engine = initializeAutomationEngine(mockLogger);
        engine.registerRule(
          "rule-1",
          defaultConfig({
            trigger: "pit-boundary",
            disableOnExit: true,
            command: "pit-limiter",
          }),
        );
        engine.activateRule("rule-1");

        simulateTelemetry({
          PlayerTrackSurface: TrkLoc.InPitStall,
          OnPitRoad: true,
          EngineWarnings: EngineWarnings.PitSpeedLimiter,
        });
        simulateTelemetry({
          PlayerTrackSurface: TrkLoc.OnTrack,
          OnPitRoad: false,
          EngineWarnings: EngineWarnings.PitSpeedLimiter,
        });

        expect(mockTap).toHaveBeenCalledWith("carControlPitSpeedLimiter");
      });

      it("should not gate other pit-boundary commands on limiter state", () => {
        const engine = initializeAutomationEngine(mockLogger);
        // Edge case: tear-off-visor with pit-boundary trigger and approach enabled.
        // resolveEffectiveTrigger in the action would coerce this to "lap", but the
        // engine itself must not apply limiter-state gating to non-limiter commands.
        engine.registerRule(
          "rule-1",
          defaultConfig({
            trigger: "pit-boundary",
            enableOnApproach: true,
            command: "tear-off-visor",
          }),
        );
        engine.activateRule("rule-1");

        simulateTelemetry({
          PlayerTrackSurface: TrkLoc.OnTrack,
          OnPitRoad: false,
          EngineWarnings: EngineWarnings.PitSpeedLimiter,
        });
        simulateTelemetry({
          PlayerTrackSurface: TrkLoc.AproachingPits,
          OnPitRoad: false,
          EngineWarnings: EngineWarnings.PitSpeedLimiter,
        });

        expect(mockTap).toHaveBeenCalledWith("carControlTearOffVisor");
      });
    });
  });

  // ─── Interval Trigger ──────────────────────────────────────────

  describe("interval trigger", () => {
    it("should not fire on first tick (seeding)", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "interval", intervalSeconds: 5 }));
      engine.activateRule("rule-1");

      simulateTelemetry({ SessionTime: 100 });
      expect(mockTap).not.toHaveBeenCalled();
    });

    it("should fire after interval elapsed", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "interval", intervalSeconds: 5 }));
      engine.activateRule("rule-1");

      simulateTelemetry({ SessionTime: 100 });
      simulateTelemetry({ SessionTime: 103 });
      expect(mockTap).not.toHaveBeenCalled();

      simulateTelemetry({ SessionTime: 105 });
      expect(mockTap).toHaveBeenCalledTimes(1);
    });

    it("should fire repeatedly at interval", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "interval", intervalSeconds: 2 }));
      engine.activateRule("rule-1");

      simulateTelemetry({ SessionTime: 0 });
      simulateTelemetry({ SessionTime: 2 });
      expect(mockTap).toHaveBeenCalledTimes(1);

      simulateTelemetry({ SessionTime: 4 });
      expect(mockTap).toHaveBeenCalledTimes(2);

      simulateTelemetry({ SessionTime: 6 });
      expect(mockTap).toHaveBeenCalledTimes(3);
    });

    it("should use correct binding key for each command", () => {
      const engine = initializeAutomationEngine(mockLogger);

      engine.registerRule(
        "r-visor",
        defaultConfig({ trigger: "interval", intervalSeconds: 1, command: "tear-off-visor" }),
      );
      engine.registerRule(
        "r-wiper",
        defaultConfig({ trigger: "interval", intervalSeconds: 1, command: "trigger-wipers" }),
      );
      engine.activateRule("r-visor");
      engine.activateRule("r-wiper");

      simulateTelemetry({ SessionTime: 0 });
      simulateTelemetry({ SessionTime: 1 });

      expect(mockTap).toHaveBeenCalledWith("carControlTearOffVisor");
      expect(mockTap).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });
  });

  // ─── Headlight Flash ───────────────────────────────────────────

  describe("headlight flash", () => {
    it("should use hold/release for headlight flash command", async () => {
      vi.useFakeTimers();
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({
          trigger: "interval",
          intervalSeconds: 1,
          command: "headlight-flash",
          flashCount: 1,
          flashDuration: 200,
        }),
      );
      engine.activateRule("rule-1");

      simulateTelemetry({ SessionTime: 0 });
      simulateTelemetry({ SessionTime: 1 });

      // Hold should be called
      expect(mockHold).toHaveBeenCalledWith("rule-1", "carControlHeadlightFlash");

      // Advance past flash duration
      await vi.advanceTimersByTimeAsync(200);

      expect(mockRelease).toHaveBeenCalledWith("rule-1");

      vi.useRealTimers();
    });

    it("should execute multiple flashes", async () => {
      vi.useFakeTimers();
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({
          trigger: "interval",
          intervalSeconds: 1,
          command: "headlight-flash",
          flashCount: 2,
          flashDuration: 100,
        }),
      );
      engine.activateRule("rule-1");

      simulateTelemetry({ SessionTime: 0 });
      simulateTelemetry({ SessionTime: 1 });

      // First flash: hold
      expect(mockHold).toHaveBeenCalledTimes(1);

      // First flash: release after duration
      await vi.advanceTimersByTimeAsync(100);
      expect(mockRelease).toHaveBeenCalledTimes(1);

      // Gap between flashes
      await vi.advanceTimersByTimeAsync(100);

      // Second flash: hold
      expect(mockHold).toHaveBeenCalledTimes(2);

      // Second flash: release
      await vi.advanceTimersByTimeAsync(100);
      expect(mockRelease).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // ─── Rule Update ───────────────────────────────────────────────

  describe("rule update", () => {
    it("should update config and reset trigger state", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule("rule-1", defaultConfig({ trigger: "interval", intervalSeconds: 5 }));
      engine.activateRule("rule-1");

      // Accumulate some state
      simulateTelemetry({ SessionTime: 0 });
      simulateTelemetry({ SessionTime: 5 });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // Update config — resets state
      engine.updateRule("rule-1", defaultConfig({ trigger: "interval", intervalSeconds: 10 }));

      // Need to re-seed after reset
      simulateTelemetry({ SessionTime: 6 });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // Old interval (5s) should not trigger
      simulateTelemetry({ SessionTime: 11 });
      expect(mockTap).toHaveBeenCalledTimes(1);

      // New interval (10s) should trigger
      simulateTelemetry({ SessionTime: 16 });
      expect(mockTap).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Multiple Rules ────────────────────────────────────────────

  describe("multiple rules", () => {
    it("should evaluate all active rules independently", () => {
      const engine = initializeAutomationEngine(mockLogger);
      engine.registerRule(
        "rule-1",
        defaultConfig({ trigger: "interval", intervalSeconds: 2, command: "tear-off-visor" }),
      );
      engine.registerRule(
        "rule-2",
        defaultConfig({ trigger: "interval", intervalSeconds: 3, command: "trigger-wipers" }),
      );
      engine.activateRule("rule-1");
      engine.activateRule("rule-2");

      simulateTelemetry({ SessionTime: 0 });

      // At t=2, only rule-1 fires
      simulateTelemetry({ SessionTime: 2 });
      expect(mockTap).toHaveBeenCalledTimes(1);
      expect(mockTap).toHaveBeenCalledWith("carControlTearOffVisor");

      // At t=3, only rule-2 fires
      simulateTelemetry({ SessionTime: 3 });
      expect(mockTap).toHaveBeenCalledTimes(2);
      expect(mockTap).toHaveBeenLastCalledWith("cockpitMiscTriggerWipers");
    });
  });
});
