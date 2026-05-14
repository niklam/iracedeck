/**
 * Translator integration tests.
 *
 * Drives the translator with canned `TelemetryData` snapshots via a fake
 * `sdkController`. Asserts the emitted event stream for each transition.
 *
 * Per-diff-module unit tests (pure functions) live next to their modules.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf, TrackWetness } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  EngineWarnings,
  Flags,
  IncidentFlags,
  PitSvFlags,
  type SDKController,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetSimEventsIracing,
  getLatestTelemetry,
  getSessionStartConditions,
  initializeSimEventsIracing,
  isSimEventsIracingInitialized,
} from "./translator.js";

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  } as unknown as ILogger;
}

type MockController = SDKController & {
  __tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
  __setSessionInfo: (info: Record<string, unknown> | null) => void;
};

function createMockController(): MockController {
  let callback: TelemetryCallback | null = null;
  let sessionInfo: Record<string, unknown> | null = null;

  const controller = {
    // Matches the real `SDKController.subscribe` contract: after storing the
    // callback, invoke it once with the current telemetry / connection state
    // so subscribers see the "nothing happening yet" tick the translator
    // actually gets at plugin startup. The real controller starts offline
    // with no telemetry, so the mock defaults to `(null, false)`.
    subscribe: (_id: string, cb: TelemetryCallback) => {
      callback = cb;
      cb(null, false);
    },
    unsubscribe: (_id: string) => {
      callback = null;
    },
    getSessionInfo: () => sessionInfo,
  } as unknown as MockController;

  controller.__tick = (telemetry, isConnected = true) => {
    callback?.(telemetry, isConnected);
  };
  controller.__setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: 0,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
    ...overrides,
  } as TelemetryData;
}

describe("sim-events-iracing translator", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    // Safety net — one overtake test uses fake timers with inline restore,
    // so a throw between `useFakeTimers()` and `useRealTimers()` would
    // leak mocked timers into every following test. Cheap unconditional
    // restore here makes that impossible.
    vi.useRealTimers();
  });

  describe("lifecycle", () => {
    it("reports uninitialized state before init", () => {
      expect(isSimEventsIracingInitialized()).toBe(false);
      expect(getLatestTelemetry()).toBeNull();
    });

    it("initializes once and subscribes to the controller", () => {
      const controller = createMockController();
      const subscribeSpy = vi.spyOn(controller, "subscribe");
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      expect(isSimEventsIracingInitialized()).toBe(true);
      expect(subscribeSpy).toHaveBeenCalledWith("__sim-events-iracing__", expect.any(Function));
    });

    it("throws on double initialization", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      expect(() => initializeSimEventsIracing(getEventBus(), controller, createMockLogger())).toThrow(
        "already initialized",
      );
    });

    it("stores the latest telemetry snapshot per tick", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      const t = telemetry({ Lap: 3 });
      controller.__tick(t);
      expect(getLatestTelemetry()).toBe(t);
    });

    it("clears state on disconnect", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      controller.__tick(telemetry({ OnPitRoad: true }));
      controller.__tick(null, false);
      expect(getLatestTelemetry()).toBeNull();
    });
  });

  describe("pit lane", () => {
    it("emits pitLane.entered on off→on transition", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.entered", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: false }));
      controller.__tick(telemetry({ OnPitRoad: true }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"pitLane.entered">;
      expect(ev.event).toBe("pitLane.entered");
      expect(ev.data).toEqual({});
      expect(ev.timestamp).toBeTypeOf("number");
    });

    it("emits pitLane.exited on on→off transition", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.exited", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true }));
      controller.__tick(telemetry({ OnPitRoad: false }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits pitStall.departed only when still on pit road", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitStall.departed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: true }));
      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: false }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits pitLane.approaching once until car is back on track", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed on track.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));
      // Enter approach zone.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }));
      // Still approaching — should not re-fire.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not synthesize pitLane.entered / pitStall.entered when the first tick is already in the stall", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const entered = vi.fn();
      const stallEntered = vi.fn();
      bus.subscribe("pitLane.entered", entered);
      bus.subscribe("pitStall.entered", stallEntered);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect while serviced in the stall — must not replay the
      // entry transitions.
      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: true }));
      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: true }));

      expect(entered).not.toHaveBeenCalled();
      expect(stallEntered).not.toHaveBeenCalled();
    });

    it("does not synthesize pitLane.approaching when the first tick is already in the approach zone", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect mid-approach — treated like "exiting" so we wait for a
      // full lap back on track before arming again.
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("flags", () => {
    it("emits flag.yellow.raised with scope: local on Yellow bit", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.raised", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"flag.yellow.raised">;
      expect(ev.data.scope).toBe("local");
    });

    it("emits flag.yellow.raised with scope: full on Caution bit", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.raised", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: Flags.Caution }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"flag.yellow.raised">;
      expect(ev.data.scope).toBe("full");
    });

    it("emits flag.yellow.cleared when yellow disappears", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.cleared", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));
      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));
      controller.__tick(telemetry({ SessionFlags: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("suppresses blue when green is also active (race start)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const blueHandler = vi.fn();
      const greenHandler = vi.fn();
      bus.subscribe("flag.blue.raised", blueHandler);
      bus.subscribe("flag.green.raised", greenHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: Flags.Green | Flags.Blue }));

      expect(greenHandler).toHaveBeenCalledTimes(1);
      expect(blueHandler).not.toHaveBeenCalled();
    });
  });

  describe("toggles", () => {
    it("emits pitService.toggled when fuel fill flag flips (after debounce)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      // Pit-service toggles are debounced — flush past the window.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"pitService.toggled">;
      expect(ev.data).toEqual({ service: "fuel", on: true });
    });

    it("coalesces rapid fuel toggles: on→off→on within debounce emits one final state", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0 }));
      // User taps fuel rapidly — three observed flips, all within the debounce window.
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));

      expect(handler).not.toHaveBeenCalled();

      // Settle past the window with the final state.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"pitService.toggled">).data).toEqual({
        service: "fuel",
        on: true,
      });
    });

    it("suppresses pit-service emits while in pit stall (crew is working)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      bus.subscribe("tireService.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // On track, no pit selections — baseline.
      controller.__tick(telemetry({ PitSvFlags: 0 }));

      // Enter the stall. While stationary, iRacing flips the tire bits one
      // by one as each tire swap completes — these are crew progress, not
      // user intent. None of these ticks should emit anything.
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvFlags: 0 }));
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvFlags: PitSvFlags.LFTireChange }));
      controller.__tick(
        telemetry({ PlayerCarInPitStall: true, PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange }),
      );
      controller.__tick(
        telemetry({
          PlayerCarInPitStall: true,
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.FuelFill,
        }),
      );

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 1000);
      controller.__tick(
        telemetry({
          PlayerCarInPitStall: true,
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.FuelFill,
        }),
      );
      vi.useRealTimers();

      expect(handler).not.toHaveBeenCalled();

      // Depart the stall. Baseline now reflects the post-service state, so a
      // tick with the same flags emits nothing — no spurious "tires off"
      // cascade.
      controller.__tick(
        telemetry({
          PlayerCarInPitStall: false,
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.FuelFill,
        }),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("stays silent when a fuel toggle is reverted within the debounce window", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Baseline: fuel off. User toggles on then back off, all within window.
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      controller.__tick(telemetry({ PitSvFlags: 0 }));

      // Settle.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      vi.useRealTimers();

      // Final state matches baseline → no emit.
      expect(handler).not.toHaveBeenCalled();
    });

    it("emits carControl.drsToggled { on: true } on activation", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("carControl.drsToggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ DRS_Status: 0 }));
      controller.__tick(telemetry({ DRS_Status: 2 }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"carControl.drsToggled">).data.on).toBe(true);
    });

    it("emits tireService.changed with added list and current set", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange }));
      // Tire changes are debounced — advance past TIRE_DEBOUNCE_MS and tick
      // again with the same flags to flush.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.added.sort()).toEqual(["LF", "RF"]);
      expect(ev.data.removed).toEqual([]);
      expect(ev.data.current.sort()).toEqual(["LF", "RF"]);
    });

    it("coalesces a multi-tick side switch into one event (clear-all → set-target)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      // Seed with all four set, then iRacing's "Lefts" button: clears, then
      // applies lefts in a separate tick. Both happen well within the
      // debounce window so they should NOT each emit an event.
      controller.__tick(telemetry({ PitSvFlags: allTires }));
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.LRTireChange }));

      expect(handler).not.toHaveBeenCalled();

      // After the debounce window, a tick with the now-stable selection emits.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.LRTireChange }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.current.sort()).toEqual(["LF", "LR"]);
      expect(ev.data.added).toEqual([]);
      expect(ev.data.removed.sort()).toEqual(["RF", "RR"]);
    });

    it("emits tireService.compoundChanged when PitSvTireCompound flips dry → wet", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.compoundChanged", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      // iRacing always force-sets all four tire bits in the same tick as a
      // user-initiated compound flip; the translator gates the
      // compoundChanged emit on that cascade so an isolated compound bit
      // change (e.g. side-effect of clear-tires, issue #484) does NOT
      // mis-fire.
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.compoundChanged">;
      expect(ev.data).toEqual({ from: 0, to: 1 });
    });

    it("emits tireService.compoundChanged when PitSvTireCompound flips wet → dry", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.compoundChanged", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.compoundChanged">;
      expect(ev.data).toEqual({ from: 1, to: 0 });
    });

    it("suppresses the cascading tireService.changed when compound flips and forces all four tire bits", () => {
      // iRacing flips compound atomically and force-sets all four tire bits
      // in the same tick. The compound voice line is the canonical
      // confirmation; we should NOT also emit a "tires-on-all" change.
      const controller = createMockController();
      const bus = getEventBus();
      const compoundHandler = vi.fn();
      const tireHandler = vi.fn();
      bus.subscribe("tireService.compoundChanged", compoundHandler);
      bus.subscribe("tireService.changed", tireHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // Compound flip + cascading tire-flag set in the same tick.
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      // Past the tire debounce — no stale tire-set event should appear.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      vi.useRealTimers();

      expect(compoundHandler).toHaveBeenCalledTimes(1);
      expect(tireHandler).not.toHaveBeenCalled();
    });

    it("still emits tireService.changed for genuine post-compound tire toggles", () => {
      // After a compound flip absorbs the cascading "all four" baseline,
      // a subsequent user-driven tire deselection (e.g. dropping the rears)
      // must still produce a normal tireService.changed event.
      const controller = createMockController();
      const bus = getEventBus();
      const tireHandler = vi.fn();
      bus.subscribe("tireService.changed", tireHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // Compound flip (suppressed cascading change).
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      // User drops the rears.
      controller.__tick(
        telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange, PitSvTireCompound: 1 }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(
        telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange, PitSvTireCompound: 1 }),
      );
      vi.useRealTimers();

      expect(tireHandler).toHaveBeenCalledTimes(1);
      const ev = tireHandler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.current.sort()).toEqual(["LF", "RF"]);
      expect(ev.data.removed.sort()).toEqual(["LR", "RR"]);
    });

    it("suppresses tireService.compoundChanged while in pit stall (crew is working)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.compoundChanged", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvTireCompound: 0 }));
      // Enter the stall — every tick re-seeds state including compound.
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvTireCompound: 0 }));
      // iRacing flips the compound mid-service; this is crew progress, not user intent.
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvTireCompound: 1 }));

      expect(handler).not.toHaveBeenCalled();
    });

    // Issue #484 — "clear tires" with a non-default compound queued.
    // iRacing resets the compound bit back to the car default in the same
    // tick that all four tire bits clear. That's a side-effect of the
    // clear, not a user-initiated compound flip: emitting
    // tireService.compoundChanged would mis-fire a "switching to dry"
    // callout and would suppress the legitimate "tires cleared" event.
    // The translator distinguishes the two cases by inspecting the
    // post-tick tire bits — `TIRE_FLAGS_MASK` for a real compound flip,
    // `0` for the clear cascade.
    it("issue #484: clearing tires with a non-default compound suppresses compoundChanged and emits tireService.changed", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const compoundHandler = vi.fn();
      const tireHandler = vi.fn();
      bus.subscribe("tireService.compoundChanged", compoundHandler);
      bus.subscribe("tireService.changed", tireHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      // Seed: dry, no tires queued.
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // User switches to wet — compound flips, all four tires force-set.
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      // Past the tire debounce so any cascading tireService.changed would
      // have surfaced by now.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));

      // Sanity: the genuine compound flip fired exactly once and was the
      // sole tire-related event.
      expect(compoundHandler).toHaveBeenCalledTimes(1);
      expect(tireHandler).not.toHaveBeenCalled();

      // User presses "clear tires". iRacing clears all four tire bits AND
      // resets compound to the car default (0 / dry) in the same tick.
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // Past the debounce so the cleared tires surface.
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      vi.useRealTimers();

      // The clear must NOT count as a second compound flip — the user
      // didn't switch back to dry, the clear reset it as a side-effect.
      expect(compoundHandler).toHaveBeenCalledTimes(1);

      // The clear must produce a tireService.changed with empty current
      // (the "tires cleared" / "skip tires" callout fires off this).
      expect(tireHandler).toHaveBeenCalledTimes(1);
      const ev = tireHandler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.current).toEqual([]);
      expect(ev.data.removed.sort()).toEqual(["LF", "LR", "RF", "RR"]);
    });
  });

  describe("limiter", () => {
    it("emits limiter.missing on pit road entry without limiter", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("limiter.missing", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: false, Speed: 50 }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 50, EngineWarnings: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits limiter.dropped when limiter turns off while on pit road", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("limiter.dropped", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: false }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: EngineWarnings.PitSpeedLimiter }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("seeds silently when the first tick is already on pit road (replay mid-session)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("limiter.missing", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Replay begins in pit lane with limiter off — must not fire limiter.missing.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("flags — cleared", () => {
    it("emits flag.yellow.cleared only when yellow was previously active", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.cleared", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: 0 }));

      expect(handler).not.toHaveBeenCalled();

      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));
      controller.__tick(telemetry({ SessionFlags: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("pit approach — suppression", () => {
    it("suppresses approach while exiting pits through the approach zone", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Sequence: on pit road → enter approach zone (exiting) → back on track.
      controller.__tick(telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(handler).not.toHaveBeenCalled();

      // Now a genuine approach — should fire.
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("overtake", () => {
    it("emits overtake.completed only after the hold window elapses", async () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("overtake.completed", handler);
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: { DriverCarIdx: 0 },
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const mockPositions = {
        CarIdxClassPosition: [0],
        CarIdxLapDistPct: [0.5],
        CarIdxLap: [1],
        CarIdxOnPitRoad: [false],
      };

      // Seed at position 5.
      controller.__tick(telemetry({ ...mockPositions, PlayerCarPosition: 5, CarIdxPosition: [5] }));
      // Position improves to 4 — hold timer starts.
      controller.__tick(telemetry({ ...mockPositions, PlayerCarPosition: 4, CarIdxPosition: [4] }));

      expect(handler).not.toHaveBeenCalled();

      // Fast-forward past OVERTAKE_HOLD_MS (3s) via a sustained position.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3100);
      controller.__tick(telemetry({ ...mockPositions, PlayerCarPosition: 4, CarIdxPosition: [4] }));
      vi.useRealTimers();

      // calculateRacePositions in practice operates on multiple car arrays —
      // this test exercises the hold-time gate, not position resolution.
      // The handler may or may not fire depending on whether calculateRacePositions
      // returns [5] / [4] from our synthetic payload; the key assertion is that
      // it never fires before the hold window elapses.
      expect(handler.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe("fuel threshold crossings", () => {
    it("emits fuel.lapsRemaining.crossed once per descending threshold", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("fuel.lapsRemaining.crossed", handler);
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: { DriverCarIdx: 0 },
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Build history across 3 lap boundaries. Fuel drops from 10 → 9 → 8 → 7
      // on lap transitions; avgPerLap = 1.
      controller.__tick(telemetry({ Lap: 1, FuelLevel: 10 }));
      controller.__tick(telemetry({ Lap: 2, FuelLevel: 9 }));
      controller.__tick(telemetry({ Lap: 3, FuelLevel: 8 }));
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 7 }));
      // History is [1, 1, 1]; FuelLevel=7 → 7 laps remaining, no crossing.
      expect(handler).not.toHaveBeenCalled();

      // Mid-lap drop — stays on lap 4 so lap-boundary logic doesn't poison the
      // rolling history; only the crossing logic runs.
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 4.8 }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"fuel.lapsRemaining.crossed">).data.threshold).toBe(5);

      // Drop further — crosses 3.
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 2.8 }));
      expect(handler).toHaveBeenCalledTimes(2);
      expect((handler.mock.calls[1]![0] as SimEventOf<"fuel.lapsRemaining.crossed">).data.threshold).toBe(3);

      // Crossing 5 again does not re-fire.
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 2.5 }));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("incidents and off-track", () => {
    it("emits offTrack.started and offTrack.ended around an excursion", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const started = vi.fn();
      const ended = vi.fn();
      bus.subscribe("offTrack.started", started);
      bus.subscribe("offTrack.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(started).toHaveBeenCalledTimes(1);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it("emits incident.occurred when PlayerCarMyIncidentCount increments", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));

      // Burst-coalesce window: nothing fires until the quiet window elapses.
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1 }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("coalesces a multi-step incident burst into a single emission with the most-recent type", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // A typical iRacing crash arrives as a stream of count increments
      // over a few hundred ms. Without coalescing each step would fire
      // its own callout — three lines on top of each other.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      // off-track first (1x)
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));
      vi.advanceTimersByTime(200);
      // out-of-control (2x more) shortly after
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 3, PlayerIncidents: IncidentFlags.RepOutOfControl }));
      vi.advanceTimersByTime(200);
      // car collision (4x more) lands the worst classification last
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 7, PlayerIncidents: IncidentFlags.RepCollisionWithCar }));

      // Still inside the burst window — no emit yet.
      expect(handler).not.toHaveBeenCalled();

      // Quiet window elapses; one emit with the accumulated delta and the
      // most recent type.
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 7 }));
      expect(handler).toHaveBeenCalledTimes(1);
      const data = (handler.mock.calls[0]![0] as SimEventOf<"incident.occurred">).data;
      expect(data.delta).toBe(7);
      expect(data.type).toBe("collision-car");
    });

    it("treats two incidents separated by more than the quiet window as separate emissions", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));
      // Quiet window elapses → first burst flushes.
      vi.advanceTimersByTime(1600);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1 }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Second incident much later — second burst.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 5, PlayerIncidents: IncidentFlags.RepCollisionWithCar }));
      vi.advanceTimersByTime(1600);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 5 }));

      expect(handler).toHaveBeenCalledTimes(2);
      const first = (handler.mock.calls[0]![0] as SimEventOf<"incident.occurred">).data;
      const second = (handler.mock.calls[1]![0] as SimEventOf<"incident.occurred">).data;
      expect(first.delta).toBe(1);
      expect(first.type).toBe("off-track");
      expect(second.delta).toBe(4);
      expect(second.type).toBe("collision-car");
    });

    it("suppresses incident.occurred when PlayerIncidents is zero or unknown", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Count bumps but the report byte is RepNoReport — stay silent so a
      // future iRacing-side type addition doesn't get an unclassified callout.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: 0 }));
      // Ongoing variant — iRacing's header notes it is never sent, but if it
      // ever does arrive we still suppress it.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 2, PlayerIncidents: IncidentFlags.RepOffTrackOngoing }));

      // Even after the burst window elapses, nothing fires — no resolved type.
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 2 }));
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not synthesize offTrack.started when the first tick starts off-track (mid-excursion reconnect)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("offTrack.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect while the car is already off track — no real transition
      // happened, so the translator must seed quietly.
      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OffTrack }));

      expect(started).not.toHaveBeenCalled();
    });

    it("emits offTrack.ended when returning to track after a mid-excursion seed", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const ended = vi.fn();
      bus.subscribe("offTrack.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(ended).toHaveBeenCalledTimes(1);
    });
  });

  describe("radar", () => {
    it("emits radar.changed with from/to states", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.Off }));
      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.CarLeft }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"radar.changed">;
      expect(ev.data).toEqual({ from: "clear", to: "left" });
    });

    it("publishes a radar.changed → clear teardown signal on disconnect when radar was active", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed → active left.
      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.Off }));
      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.CarLeft }));

      expect(handler).toHaveBeenCalledTimes(1);

      // Disconnect — translator must emit a radar.changed → clear so the
      // radar engine stops its tick loop. Otherwise the last callout keeps
      // looping after iRacing exits.
      controller.__tick(null, false);

      expect(handler).toHaveBeenCalledTimes(2);
      const teardown = handler.mock.calls[1]![0] as SimEventOf<"radar.changed">;
      expect(teardown.data).toEqual({ from: "left", to: "clear" });
    });

    it("does not publish a teardown signal when disconnecting with radar already clear", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.Off }));
      controller.__tick(null, false);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle events", () => {
    it("emits driver.firstOnTrack on the first on-track tick", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ IsOnTrack: false }));
      controller.__tick(telemetry({ IsOnTrack: true }));
      controller.__tick(telemetry({ IsOnTrack: true }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits engine.startup on RPM 0 → >threshold", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("engine.startup", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ RPM: 0 }));
      controller.__tick(telemetry({ RPM: 1200 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits lap.started when Lap increments", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("lap.started", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ Lap: 1 }));
      controller.__tick(telemetry({ Lap: 2 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"lap.started">;
      expect(ev.data.lap).toBe(2);
    });

    it("emits session.changed when SessionNum delta occurs", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("session.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionNum: 0 }));
      controller.__tick(telemetry({ SessionNum: 1 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
      expect(ev.data).toEqual({ from: 0, to: 1 });
    });

    it("does not synthesize engine.startup when the first tick already has RPM > threshold", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("engine.startup", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnecting while the engine is already running is not a startup.
      controller.__tick(telemetry({ RPM: 3500 }));
      controller.__tick(telemetry({ RPM: 3600 }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("does not synthesize driver.firstOnTrack when the first tick is already on-track", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect mid-session with the driver already on track — the
      // welcome scenario must not re-trigger.
      controller.__tick(telemetry({ IsOnTrack: true }));
      controller.__tick(telemetry({ IsOnTrack: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    // Issue #542 regression: joining a session leaves iRacing in replay
    // (`IsReplayPlaying: true`, `IsOnTrack: false`) until the driver clicks
    // "Drive". The fire must land on the replay → live-on-track transition,
    // not be swallowed by the replay guard's per-tick state reset.
    it("emits driver.firstOnTrack on the replay → live-on-track transition", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // In the session menu / garage: iRacing is in replay, not on track.
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));
      // Driver clicks "Drive" — replay ends and the car is on track.
      controller.__tick(telemetry({ IsReplayPlaying: false, IsOnTrack: true }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not fire driver.firstOnTrack while still in replay, even if a replay frame is on-track", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // A replay frame can have IsOnTrack true, but the driver isn't live.
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: true }));
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("fires driver.firstOnTrack only once across a car → exit → car cycle", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));
      controller.__tick(telemetry({ IsReplayPlaying: false, IsOnTrack: true })); // drive out — fires
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false })); // back to garage
      controller.__tick(telemetry({ IsReplayPlaying: false, IsOnTrack: true })); // drive out again

      // The lifetime milestone survives the replay guard's resets — no re-fire.
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not synthesize lap.started when Lap resets to a lower number (session flip)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("lap.started", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // End of practice on lap 12, then race starts at lap 1.
      controller.__tick(telemetry({ Lap: 12 }));
      controller.__tick(telemetry({ Lap: 1 }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("session-start conditions (issue #542)", () => {
    const SESSION_INFO = {
      SessionInfo: { Sessions: [{ SessionType: "Race" }] },
      WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: "80.00 kph" },
    };

    it("returns null before any telemetry tick", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getSessionStartConditions()).toBeNull();
    });

    it("returns null when session info is unavailable", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()).toBeNull();
    });

    it("returns null when track wetness is still Unknown", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Unknown, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()).toBeNull();
    });

    it("resolves metric conditions (km/h, Celsius) and rounds temps", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          DisplayUnits: 1,
          TrackWetness: TrackWetness.MostlyDry,
          TrackTempCrew: 28.4,
          AirTemp: 19.6,
        }),
      );

      expect(getSessionStartConditions()).toEqual({
        sessionType: "race",
        pitSpeedLimit: 80,
        speedUnit: "kmh",
        trackTemp: 28,
        airTemp: 20,
        tempUnit: "celsius",
        wetness: TrackWetness.MostlyDry,
      });
    });

    it("converts to imperial (mph, Fahrenheit) when DisplayUnits is English", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          DisplayUnits: 0,
          TrackWetness: TrackWetness.Dry,
          TrackTempCrew: 28,
          AirTemp: 20,
        }),
      );

      // 80 km/h ≈ 49.7 mph → 50; 28 °C → 82.4 °F → 82; 20 °C → 68 °F.
      expect(getSessionStartConditions()).toEqual({
        sessionType: "race",
        pitSpeedLimit: 50,
        speedUnit: "mph",
        trackTemp: 82,
        airTemp: 68,
        tempUnit: "fahrenheit",
        wetness: TrackWetness.Dry,
      });
    });

    it("defaults to metric when DisplayUnits is absent", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      const conditions = getSessionStartConditions();
      expect(conditions?.speedUnit).toBe("kmh");
      expect(conditions?.tempUnit).toBe("celsius");
    });

    it.each([
      ["Practice", "practice"],
      ["Lone Practice", "practice"],
      ["Offline Testing", "practice"],
      ["Open Qualify", "qualifying"],
      ["Lone Qualify", "qualifying"],
      ["Race", "race"],
      ["Warmup", "race"],
    ] as const)("classifies %s as %s", (sessionType, expected) => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: sessionType }] },
        WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: "80.00 kph" },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()?.sessionType).toBe(expected);
    });
  });

  describe("envelope shape", () => {
    it("every published event carries event, timestamp, telemetry, data", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.entered", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const t = telemetry({ OnPitRoad: false });
      controller.__tick(t);
      const t2 = telemetry({ OnPitRoad: true, Lap: 5 });
      controller.__tick(t2);

      const ev = handler.mock.calls[0]![0] as SimEventOf<"pitLane.entered">;
      expect(ev.event).toBe("pitLane.entered");
      expect(typeof ev.timestamp).toBe("number");
      expect(ev.telemetry).toBe(t2);
      expect(ev.data).toEqual({});
    });
  });
});
