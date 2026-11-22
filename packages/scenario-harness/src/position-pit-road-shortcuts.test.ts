/**
 * The position shortcuts against the real pit-road check (#1722).
 *
 * No position readout starts while the player is on pit road or out of the
 * car: each one asks in `where:` and again at speak time, reading the
 * translator's latest tick. The mock boots out of the car (`IsOnTrack: false`),
 * so every shortcut whose publish reaches a position readout puts the car on
 * track first — `inCarOnTrack` for the position-change and race-status
 * buttons, while the overtake buttons' `atRacingSpeed` already does. This
 * file pins:
 *
 * - WHICH shortcuts need it, derived rather than listed: the catalog is
 *   registered for real and the four position readouts' own `where:` is asked
 *   about every shortcut's publish, on track and out of the car.
 * - That the setup step works the way the UI runs it — posted to
 *   `/api/telemetry` with the mock's tick loop paused.
 *
 * That the car left on track changes no other shortcut is pinned beside the
 * overtake gate's, in `overtake-gate-shortcuts.test.ts`.
 */
import { _resetAudioScenarios, initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import {
  PERMISSIVE_OVERTAKE_GATE,
  playerOnPitRoadOrOutOfCar,
  registerPitCrew,
} from "@iracedeck/audio-scenarios/pit-crew";
import { createFakeAudio } from "@iracedeck/audio-service/testing";
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf } from "@iracedeck/event-bus";
import { type SDKController, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { _resetSimEventsIracing, getLatestTelemetry, initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";
import type { FastifyInstance } from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAudioAssetsManifest } from "./bootstrap-settings.js";
import { ALL_EVENT_NAMES } from "./event-names.js";
import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
import {
  AT_RACING_SPEED,
  IN_CAR_ON_TRACK,
  inCarOnTrack,
  SCENARIO_SHORTCUTS,
  type TelemetryStep,
} from "./scenario-shortcuts.js";
import { createServer } from "./server.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The four contracts that say the player's position (#1722 decision 1). */
const POSITION_READOUT_IDS = [
  "pit-crew.position-change",
  "pit-crew.race-status",
  "pit-crew.overtake-gained-position",
  "pit-crew.overtake-lost-position",
];

/** The shortcuts `inCarOnTrack` wrapped: their first step is the shared in-car step. */
const IN_CAR_WRAPPED = SCENARIO_SHORTCUTS.filter((s) => s.telemetrySequence?.[0] === IN_CAR_ON_TRACK);

/** The shortcuts `atRacingSpeed` wrapped, which put the car on track too. */
const AT_SPEED_WRAPPED = new Set(
  SCENARIO_SHORTCUTS.filter((s) => s.telemetrySequence?.[0] === AT_RACING_SPEED).map((s) => s.id),
);

describe("which shortcuts reach a position readout", () => {
  /** The tick the readouts' check reads, switched between the two states the derivation compares. */
  let telemetry: TelemetryData | null = null;
  const ON_TRACK = { IsOnTrack: true, OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack } as TelemetryData;
  const OUT_OF_CAR = { IsOnTrack: false, OnPitRoad: false, PlayerTrackSurface: TrkLoc.NotInWorld } as TelemetryData;

  /** Each shortcut id, with the position readouts its publish reaches on track. */
  const reached = new Map<string, string[]>();
  /** Shortcut ids whose publish reaches a readout out of the car too — the check would not be the one deciding. */
  const reachedOutOfCar: string[] = [];

  beforeAll(() => {
    const bus = initializeEventBus(silentLogger);
    const engine = initializeAudioScenarios(
      bus,
      createFakeAudio(),
      getAudioAssetsManifest(),
      silentLogger,
      () => "default",
    );
    const defineContract = vi.spyOn(engine, "defineContract");

    // Every other read the four `where:`s make is opened, so the pit-road
    // check is the one that decides: a readable live position, the overtake
    // gate clear, and the race neither finished nor under a caution (the
    // defaults).
    registerPitCrew(bus, {
      getLatestTelemetry: () => telemetry,
      getLivePosition: () => ({ position: 5, classPosition: 5, isMultiClass: false }),
      getOvertakeGate: () => PERMISSIVE_OVERTAKE_GATE,
    });

    const readouts = defineContract.mock.calls
      .map(([contract]) => contract)
      .filter((contract) => POSITION_READOUT_IDS.includes(contract.id));

    // All four, or the derivation below reads a narrower catalog than ships.
    expect(readouts.map((c) => c.id).sort()).toEqual([...POSITION_READOUT_IDS].sort());

    /** Which readouts take one of these events, with the car in `state`. */
    function readoutsTaking(
      events: readonly { event: string; data: Record<string, unknown> }[],
      state: TelemetryData,
    ): string[] {
      telemetry = state;

      return readouts
        .filter((contract) =>
          events.some(({ event, data }) => {
            if (contract.when?.event !== event) return false;

            const ev = { event, timestamp: 0, telemetry: null, data } as unknown as SimEventOf<never>;

            return contract.when.where === undefined || contract.when.where(ev as never);
          }),
        )
        .map((contract) => contract.id);
    }

    for (const shortcut of SCENARIO_SHORTCUTS) {
      if (shortcut.event === undefined) continue;

      const events = [...(shortcut.precedingEvents ?? []), { event: shortcut.event, data: shortcut.data }];
      const onTrack = readoutsTaking(events, ON_TRACK);

      if (onTrack.length > 0) reached.set(shortcut.id, onTrack);

      if (readoutsTaking(events, OUT_OF_CAR).length > 0) reachedOutOfCar.push(shortcut.id);
    }
  });

  afterAll(() => {
    _resetAudioScenarios();
    _resetEventBus();
  });

  it("finds shortcuts reaching every one of the four readouts — the derivation is not vacuous", () => {
    const readouts = new Set([...reached.values()].flat());

    expect([...readouts].sort()).toEqual([...POSITION_READOUT_IDS].sort());
  });

  it("is decided by the pit-road check: no shortcut reaches a position readout with the car out of it", () => {
    expect(reachedOutOfCar).toEqual([]);
  });

  it("puts the car on track first for exactly the shortcuts reaching a readout the overtake setup does not cover", () => {
    const needsIt = [...reached.keys()].filter((id) => !AT_SPEED_WRAPPED.has(id)).sort();

    expect(IN_CAR_WRAPPED.map((s) => s.id).sort()).toEqual(needsIt);
  });

  it("leaves no shortcut that reaches a position readout without a step putting the car on track", () => {
    const unwrapped = [...reached.keys()].filter(
      (id) => !AT_SPEED_WRAPPED.has(id) && !IN_CAR_WRAPPED.some((s) => s.id === id),
    );

    expect(unwrapped).toEqual([]);
  });

  it("wraps no shortcut twice", () => {
    expect(IN_CAR_WRAPPED.filter((s) => AT_SPEED_WRAPPED.has(s.id)).map((s) => s.id)).toEqual([]);
  });
});

describe("inCarOnTrack", () => {
  const base = { id: "x", category: "Test", label: "X", event: "lap.completed", data: {} } as const;

  it("puts the in-car step ahead of a sequence the shortcut already carries", () => {
    const own: TelemetryStep = { patch: { OnPitRoad: true }, holdMs: 50 };

    expect(inCarOnTrack({ ...base, telemetrySequence: [own] }).telemetrySequence).toEqual([IN_CAR_ON_TRACK, own]);
  });

  it("adds no precondition: with no tick held the check admits, so a disconnected press is heard", () => {
    expect(inCarOnTrack(base).requires).toBeUndefined();
    expect(inCarOnTrack({ ...base, requires: ["player-car-index"] }).requires).toEqual(["player-car-index"]);
    expect(playerOnPitRoadOrOutOfCar(null)).toBe(false);
  });

  it("appends its note to a description, and is the whole description when there is none", () => {
    const described = inCarOnTrack({ ...base, description: "A lap." }).description ?? "";
    const bare = inCarOnTrack(base).description ?? "";

    expect(described.startsWith("A lap. Puts the car on track")).toBe(true);
    expect(bare.startsWith("Puts the car on track")).toBe(true);
  });

  it("leaves pit road and the speed alone, so a car parked on pit road hears the real suppression", () => {
    expect(IN_CAR_ON_TRACK.patch).not.toHaveProperty("OnPitRoad");
    expect(IN_CAR_ON_TRACK.patch).not.toHaveProperty("Speed");
    expect(IN_CAR_ON_TRACK.tick).toBe(true);
  });
});

describe("the in-car step, run the way the UI runs it", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const bus = initializeEventBus(silentLogger);
    // Connected and seeded at the boot telemetry, and never started: the
    // harness with its tick loop paused, where only the step's own `tick`
    // can put the patch in front of a publish.
    const controller = new MockSDKController({ onSubscriberError: "rethrow" });
    controller.setConnected(true);
    initializeSimEventsIracing(bus, controller as unknown as SDKController, silentLogger, { onStepError: "rethrow" });
    controller.tickOnce();

    app = await createServer({
      controller,
      adapter: {} as unknown as MockPlatformAdapter,
      bus,
      audio: createFakeAudio(),
      packageRoot: PACKAGE_ROOT,
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    await app.close();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  /** Each step posted as the UI posts it: the step object itself is the body. */
  async function postSteps(steps: readonly TelemetryStep[]): Promise<void> {
    for (const step of steps) {
      const res = await app.inject({ method: "POST", url: "/api/telemetry", payload: step });

      expect(res.statusCode).toBe(200);
    }
  }

  it("the mock's boot telemetry is out of the car, which silences every position readout", () => {
    expect(getLatestTelemetry()).not.toBeNull();
    expect(playerOnPitRoadOrOutOfCar(getLatestTelemetry())).toBe(true);
  });

  it("would leave the check refusing before the publish if the step did not ask for a tick", async () => {
    await postSteps([{ patch: IN_CAR_ON_TRACK.patch, holdMs: 100 }]);

    expect(playerOnPitRoadOrOutOfCar(getLatestTelemetry())).toBe(true);
  });

  it.each(IN_CAR_WRAPPED.map((s) => s.id))("%s puts the car on track before its publish", async (id) => {
    await postSteps(SCENARIO_SHORTCUTS.find((s) => s.id === id)?.telemetrySequence ?? []);

    expect(playerOnPitRoadOrOutOfCar(getLatestTelemetry())).toBe(false);
  });

  it("still refuses with the car parked on pit road — the step leaves OnPitRoad alone", async () => {
    await postSteps([{ patch: { OnPitRoad: true }, tick: true }, IN_CAR_ON_TRACK]);

    expect(playerOnPitRoadOrOutOfCar(getLatestTelemetry())).toBe(true);
  });

  it("gets there publishing nothing but the first-on-track event no callout consumes", async () => {
    const events: string[] = [];

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => events.push(ev.event));
    }

    for (const shortcut of IN_CAR_WRAPPED) {
      await postSteps(shortcut.telemetrySequence ?? []);
    }

    expect(events.filter((name) => name !== "driver.firstOnTrack")).toEqual([]);
  });
});
