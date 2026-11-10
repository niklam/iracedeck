/**
 * The pit limiter's on / off edge (issue #1272): one `carControl.limiterToggled`
 * per change of the engaged bit, on track, on pit road and in the pit stall, and
 * silence on the first tick, out of the car, during pit service and out of the
 * world, each with the 500 ms tail the spec names. The diff is called directly,
 * with an explicit clock.
 */
import { EngineWarnings, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createLimiterToggleState, type LimiterToggleState } from "../state.js";
import { diffLimiterToggle, LIMITER_SERVICE_SETTLE_MS } from "./limiter-toggle.js";
import type { PendingEvent } from "./types.js";

type Where = "track" | "pitRoad" | "stall";

type Tick = {
  /** The `EngineWarnings.PitSpeedLimiter` bit. */
  on: boolean;
  where?: Where;
  /** `undefined` omits `IsOnTrack` entirely. */
  onTrack?: boolean | undefined;
  /** `undefined` omits `PitstopActive` entirely, the older-telemetry case. */
  service?: boolean | undefined;
  /** `undefined` omits `PlayerTrackSurface` entirely; by default the surface `where` implies. */
  surface?: number | undefined;
};

const SURFACE: Record<Where, number> = {
  track: TrkLoc.OnTrack,
  pitRoad: TrkLoc.AproachingPits,
  stall: TrkLoc.InPitStall,
};

function telemetry(tick: Tick): TelemetryData {
  const where = tick.where ?? "track";
  const t: Record<string, unknown> = {
    EngineWarnings: tick.on ? EngineWarnings.PitSpeedLimiter : 0,
    OnPitRoad: where !== "track",
    PlayerCarInPitStall: where === "stall",
  };

  if (!("onTrack" in tick)) t.IsOnTrack = true;
  else if (tick.onTrack !== undefined) t.IsOnTrack = tick.onTrack;

  if (!("service" in tick)) t.PitstopActive = false;
  else if (tick.service !== undefined) t.PitstopActive = tick.service;

  if (!("surface" in tick)) t.PlayerTrackSurface = SURFACE[where];
  else if (tick.surface !== undefined) t.PlayerTrackSurface = tick.surface;

  return t as TelemetryData;
}

/** One tick at `now`: what it published. */
function feed(limiter: LimiterToggleState, now: number, tick: Tick): PendingEvent[] {
  const events: PendingEvent[] = [];

  diffLimiterToggle(limiter, telemetry(tick), now, (e) => events.push(e));

  return events;
}

/** A slice seeded at t=0 with the limiter `on` at `where`. */
function seeded(on: boolean, where: Where = "track"): LimiterToggleState {
  const limiter = createLimiterToggleState();
  expect(feed(limiter, 0, { on, where })).toEqual([]);

  return limiter;
}

const ON = { event: "carControl.limiterToggled", data: { on: true } } as const;
const OFF = { event: "carControl.limiterToggled", data: { on: false } } as const;

const T = 10_000;

describe("diffLimiterToggle (issue #1272)", () => {
  describe("an edge publishes, anywhere on track", () => {
    it.each<Where>(["track", "pitRoad", "stall"])("exactly one per off→on edge, and one per on→off, on %s", (where) => {
      const limiter = seeded(false, where);

      expect(feed(limiter, T, { on: true, where })).toEqual([ON]);
      expect(feed(limiter, T + 16, { on: true, where })).toEqual([]);
      expect(feed(limiter, T + 32, { on: false, where })).toEqual([OFF]);
      expect(feed(limiter, T + 48, { on: false, where })).toEqual([]);
    });

    it("gives two on: true for on → off → on, with no debounce", () => {
      const limiter = seeded(false);

      expect([
        ...feed(limiter, T, { on: true }),
        ...feed(limiter, T + 16, { on: false }),
        ...feed(limiter, T + 32, { on: true }),
      ]).toEqual([ON, OFF, ON]);
    });

    it("publishes a press in the stall the car was placed in, once the placement has settled", () => {
      // Getting in the car: out of the car and out of the world, then in the
      // car still out of the world, then in the stall (the 2026-10-11
      // captures' first ticks). A press after the tail is the driver's.
      const limiter = createLimiterToggleState();

      expect(feed(limiter, 0, { on: false, onTrack: false, surface: TrkLoc.NotInWorld })).toEqual([]);
      expect(feed(limiter, 100, { on: false, surface: TrkLoc.NotInWorld })).toEqual([]);
      expect(feed(limiter, 116, { on: false, where: "stall" })).toEqual([]);
      expect(feed(limiter, 5_000, { on: true, where: "stall" })).toEqual([ON]);
    });
  });

  describe("silent seeds", () => {
    it("says nothing on the first tick with the bit set, nor while it stays set", () => {
      const limiter = createLimiterToggleState();

      expect(feed(limiter, 0, { on: true })).toEqual([]);
      expect(feed(limiter, 16, { on: true })).toEqual([]);
      // The baseline is the bit: the next change is an ordinary edge.
      expect(feed(limiter, 32, { on: false })).toEqual([OFF]);
    });

    it("follows the bit while IsOnTrack is false, so coming back with it set says nothing", () => {
      const limiter = seeded(false);

      expect(feed(limiter, T, { on: true, onTrack: false })).toEqual([]);
      expect(feed(limiter, T + 16, { on: true, onTrack: false })).toEqual([]);
      expect(feed(limiter, T + 32, { on: true })).toEqual([]);
    });

    it("reads a missing IsOnTrack as out of the car", () => {
      const limiter = seeded(false);

      expect(feed(limiter, T, { on: true, onTrack: undefined })).toEqual([]);
      expect(feed(limiter, T + 16, { on: true })).toEqual([]);
    });

    it("says nothing on leaving the stall with the bit set", () => {
      const limiter = seeded(true, "stall");

      expect(feed(limiter, T, { on: true, where: "pitRoad" })).toEqual([]);
      expect(feed(limiter, T + 16, { on: true })).toEqual([]);
    });

    it("re-seeds after the slice is recreated, as the replay wipe does", () => {
      const limiter = seeded(false);

      // The wipe recreates the slice; the bit went on while the replay was up.
      Object.assign(limiter, createLimiterToggleState());

      expect(feed(limiter, T, { on: true })).toEqual([]);
    });
  });

  describe("pit service", () => {
    it("says nothing for a change while PitstopActive is true, in either direction", () => {
      const limiter = seeded(true, "stall");

      expect(feed(limiter, T, { on: false, where: "stall", service: true })).toEqual([]);
      expect(feed(limiter, T + 16, { on: true, where: "stall", service: true })).toEqual([]);
      expect(feed(limiter, T + 32, { on: false, where: "stall", service: true })).toEqual([]);
    });

    it("reads PitstopActive wherever the car is: it leads the stall flag on pit road", () => {
      const limiter = seeded(false, "pitRoad");

      expect(feed(limiter, T, { on: true, where: "pitRoad", service: true })).toEqual([]);
    });

    it("says nothing for a change on the tick service falls", () => {
      const limiter = seeded(true, "stall");

      feed(limiter, T, { on: true, where: "stall", service: true });
      expect(feed(limiter, T + 16, { on: false, where: "stall" })).toEqual([]);
    });

    it("says nothing on the tick service falls even when that tick comes long after the last service tick", () => {
      // The tail is counted from the tick that clears service, not the last
      // tick that saw it, so a hitch cannot open it early.
      const limiter = seeded(true, "stall");

      feed(limiter, T, { on: true, where: "stall", service: true });
      expect(feed(limiter, T + 2_000, { on: false, where: "stall" })).toEqual([]);
    });

    it("says nothing within LIMITER_SERVICE_SETTLE_MS after it falls, and publishes the first change after", () => {
      const limiter = seeded(true, "stall");
      const fall = T + 16;

      feed(limiter, T, { on: true, where: "stall", service: true });
      expect(feed(limiter, fall, { on: true, where: "stall" })).toEqual([]);
      expect(feed(limiter, fall + LIMITER_SERVICE_SETTLE_MS - 1, { on: false, where: "stall" })).toEqual([]);
      expect(feed(limiter, fall + LIMITER_SERVICE_SETTLE_MS, { on: true, where: "stall" })).toEqual([ON]);
    });

    it("does not silence on a missing PitstopActive", () => {
      const limiter = seeded(false, "stall");

      expect(feed(limiter, T, { on: true, where: "stall", service: undefined })).toEqual([ON]);
    });
  });

  describe("tow and reset", () => {
    it.each([
      { name: "changes across it", before: true, outOfWorld: true, landing: false },
      { name: "changes on the out-of-world tick", before: false, outOfWorld: true, landing: true },
      { name: "changes on the landing tick", before: false, outOfWorld: false, landing: true },
      { name: "does not change", before: true, outOfWorld: true, landing: true },
    ])("says nothing when the bit $name", ({ before, outOfWorld, landing }) => {
      const limiter = seeded(before);

      // A tow or reset keeps IsOnTrack true: one tick out of the world, then the stall.
      expect(feed(limiter, T, { on: outOfWorld, surface: TrkLoc.NotInWorld })).toEqual([]);
      expect(feed(limiter, T + 10, { on: landing, where: "stall" })).toEqual([]);
    });

    it("says nothing within LIMITER_SERVICE_SETTLE_MS after the car is back, and publishes the first change after", () => {
      const limiter = seeded(false);
      const back = T + 10;

      feed(limiter, T, { on: false, surface: TrkLoc.NotInWorld });
      expect(feed(limiter, back, { on: false, where: "stall" })).toEqual([]);
      expect(feed(limiter, back + LIMITER_SERVICE_SETTLE_MS - 1, { on: true, where: "stall" })).toEqual([]);
      expect(feed(limiter, back + LIMITER_SERVICE_SETTLE_MS, { on: false, where: "stall" })).toEqual([OFF]);
    });

    it("does not silence on a missing PlayerTrackSurface", () => {
      const limiter = seeded(false);

      expect(feed(limiter, T, { on: true, surface: undefined })).toEqual([ON]);
    });

    type CaptureRow = {
      t: number;
      IsOnTrack: boolean;
      OnPitRoad: boolean;
      PlayerCarInPitStall: boolean;
      PlayerTrackSurface: number;
      PitstopActive?: boolean;
    };

    const capture = (name: string): CaptureRow[] =>
      JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")) as CaptureRow[];

    it.each([
      { name: "tire-temps-tow-20261011.json", outOfWorld: 18 },
      { name: "tire-temps-stops-20261011.json", outOfWorld: 27 },
    ])("says nothing for a limiter that flips at the landing in $name", ({ name, outOfWorld }) => {
      // The capture's own flags from two ticks before the tow to the landing,
      // with the limiter switched off on the landing tick (it does not record
      // EngineWarnings, so the bit is the test's).
      const rows = capture(name).slice(outOfWorld - 2, outOfWorld + 2);
      const limiter = createLimiterToggleState();
      const events: PendingEvent[] = [];

      expect(rows[2]!.PlayerTrackSurface).toBe(TrkLoc.NotInWorld);
      expect(rows[2]!.IsOnTrack).toBe(true);
      expect(rows[3]!.PlayerCarInPitStall).toBe(true);

      rows.forEach((row, i) => {
        const { t, ...flags } = row;
        const tick = {
          ...flags,
          EngineWarnings: i < 3 ? EngineWarnings.PitSpeedLimiter : 0,
        } as TelemetryData;

        diffLimiterToggle(limiter, tick, t * 1000, (e) => events.push(e));
      });

      expect(events).toEqual([]);
    });
  });
});
