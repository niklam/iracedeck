/**
 * The overtake and gap shortcuts against the real overtake gate (#1349 slice 2).
 *
 * The harness runs the plugins' own wiring, whose overtake gate reads live
 * telemetry — on track, at least 50 km/h, off pit road, nobody alongside — and
 * the overtake and gap callouts both check it in `where:`. So every shortcut
 * publishing one of those events puts the car on track at racing speed first
 * (`atRacingSpeed`) and refuses to start while the mock SDK is disconnected.
 * This file pins three things about that:
 *
 * - WHICH shortcuts need it, derived rather than listed: the catalog is
 *   registered for real with a spy as its overtake gate, and every shortcut's
 *   publish is replayed at it.
 * - That the setup step works the way the UI runs it — posted to
 *   `/api/telemetry` with the mock's tick loop paused — rather than through a
 *   test helper that ticks after every patch.
 * - That the car left on track at racing speed changes no other shortcut.
 */
import { _resetAudioScenarios, initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import { overtakeContextAllows, type OvertakeGateResolver, registerPitCrew } from "@iracedeck/audio-scenarios/pit-crew";
import type { IAudioService } from "@iracedeck/audio-service";
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import type { SDKController, SessionInfo } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { createIracingSimRuntime } from "@iracedeck/race-engineer-wiring";
import { _resetSimEventsIracing, initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAudioAssetsManifest } from "./bootstrap-settings.js";
import { ALL_EVENT_NAMES, EVENT_TEMPLATES, OVERTAKE_GATE_NOTE } from "./event-names.js";
import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import {
  AT_RACING_SPEED,
  atRacingSpeed,
  SCENARIO_SHORTCUTS,
  type ScenarioShortcut,
  type TelemetryStep,
} from "./scenario-shortcuts.js";
import { createServer } from "./server.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The shortcuts `atRacingSpeed` wrapped: their first step is the shared racing-speed step. */
const WRAPPED = SCENARIO_SHORTCUTS.filter((s) => s.telemetrySequence?.[0] === AT_RACING_SPEED);

/** The gate as the wiring composes it from the running translator, with no incident on record. */
function gateAllows(): boolean {
  const gate = createIracingSimRuntime().getOvertakeTelemetryGate();

  return gate !== null && overtakeContextAllows({ ...gate, msSinceIncident: null });
}

/** One publish as `/api/bus/publish` makes it: the mock's current telemetry as the envelope. */
function publish(event: string, data: Record<string, unknown>, telemetry: unknown): void {
  getEventBus().publish({ event: event as SimEventName, timestamp: Date.now(), telemetry, data } as never);
}

describe("which shortcuts the overtake gate decides", () => {
  // The catalog, registered once on one bus: `registerPitCrew` binds the radar,
  // spotter and pit-speeding engines to the first bus it sees and refuses
  // another, and their resets are not exported from the package.
  const gate = vi.fn<OvertakeGateResolver>(() => null);
  const gatedShortcutIds: string[] = [];
  const gatedEvents: string[] = [];

  /** Whether publishing these events consults the gate, any delayed `where:` included. */
  function readsGate(events: readonly { event: string; data: Record<string, unknown> }[]): boolean {
    gate.mockClear();

    for (const { event, data } of events) publish(event, data, null);

    vi.advanceTimersByTime(30_000);

    return gate.mock.calls.length > 0;
  }

  beforeAll(() => {
    vi.useFakeTimers();

    const bus = initializeEventBus(silentLogger);
    // Every method a no-op spy: the gate answers `null`, which refuses, so no
    // gated line plays; whatever else a publish triggers only needs to not throw.
    const audio = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (target[key] ??= vi.fn()),
    }) as unknown as IAudioService;

    initializeAudioScenarios(bus, audio, getAudioAssetsManifest(), silentLogger, () => "default");
    registerPitCrew(bus, { getOvertakeGate: gate });

    for (const shortcut of SCENARIO_SHORTCUTS) {
      if (shortcut.event === undefined) continue;

      if (readsGate([...(shortcut.precedingEvents ?? []), { event: shortcut.event, data: shortcut.data }])) {
        gatedShortcutIds.push(shortcut.id);
      }
    }

    for (const template of EVENT_TEMPLATES) {
      if (readsGate([{ event: template.name, data: template.data }])) gatedEvents.push(template.name);
    }
  });

  afterAll(() => {
    _resetAudioScenarios();
    _resetEventBus();
    vi.useRealTimers();
  });

  it("puts the car on track at racing speed first for exactly the shortcuts whose publish reads the gate", () => {
    // Non-empty, or the equality below would hold with no gate read anywhere.
    expect(gatedShortcutIds.length).toBeGreaterThan(0);
    expect(WRAPPED.map((s) => s.id).sort()).toEqual([...gatedShortcutIds].sort());
  });

  it("refuses each of them while the mock SDK is disconnected", () => {
    for (const shortcut of WRAPPED) {
      expect(shortcut.requires, shortcut.id).toContain("sdk-connected");
    }
  });

  it("notes the gate on the injector templates of exactly the events whose callouts read it", () => {
    expect(gatedEvents.length).toBeGreaterThan(0);
    expect(
      EVENT_TEMPLATES.filter((t) => t.description.includes(OVERTAKE_GATE_NOTE))
        .map((t) => t.name)
        .sort(),
    ).toEqual([...gatedEvents].sort());
  });
});

describe("atRacingSpeed", () => {
  const base = { id: "x", category: "Test", label: "X", event: "overtake.completed", data: {} } as const;

  it("puts the racing-speed step ahead of a sequence the shortcut already carries", () => {
    const own: TelemetryStep = { patch: { CarLeftRight: 0 }, holdMs: 50 };

    expect(atRacingSpeed({ ...base, telemetrySequence: [own] }).telemetrySequence).toEqual([AT_RACING_SPEED, own]);
  });

  it("keeps the shortcut's own requirements beside the connection", () => {
    expect(atRacingSpeed({ ...base, requires: ["player-car-index"] }).requires).toEqual([
      "player-car-index",
      "sdk-connected",
    ]);
  });

  it("appends its note to a description, and is the whole description when there is none", () => {
    const described = atRacingSpeed({ ...base, description: "A pass." }).description ?? "";
    const bare = atRacingSpeed(base).description ?? "";

    expect(described.startsWith("A pass. Puts the car on track")).toBe(true);
    expect(bare.startsWith("Puts the car on track")).toBe(true);
  });
});

describe("the racing-speed step, run the way the UI runs it", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const bus = initializeEventBus(silentLogger);
    // Connected and seeded at the boot telemetry, and never started: the
    // harness with its tick loop paused, where a hold lets no tick through at
    // all. Only the step's own `tick` can put the patch in front of a publish.
    const controller = new MockSDKController();
    controller.setConnected(true);
    initializeSimEventsIracing(bus, controller as unknown as SDKController, silentLogger);
    controller.tickOnce();

    app = await createServer({
      controller,
      adapter: {} as unknown as MockPlatformAdapter,
      bus,
      audio: { setPlaybackObserver: () => {} } as unknown as IAudioService,
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

  it("leaves the gate shut on the mock's boot telemetry", () => {
    expect(createIracingSimRuntime().getOvertakeTelemetryGate()).not.toBeNull();
    expect(gateAllows()).toBe(false);
  });

  it("would leave it shut before the publish if the step did not ask for a tick", async () => {
    // The race the `tick` closes: the same patch, with the timer paused.
    await postSteps([{ patch: AT_RACING_SPEED.patch, holdMs: 100 }]);

    expect(gateAllows()).toBe(false);
  });

  it.each(WRAPPED.map((s) => s.id))("%s opens the gate before its publish", async (id) => {
    await postSteps(SCENARIO_SHORTCUTS.find((s) => s.id === id)?.telemetrySequence ?? []);

    expect(gateAllows()).toBe(true);
  });

  it("gets there publishing nothing but the first-on-track event no callout consumes", async () => {
    const events: string[] = [];

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => events.push(ev.event));
    }

    for (const shortcut of WRAPPED) {
      await postSteps(shortcut.telemetrySequence ?? []);
    }

    expect(events.filter((name) => name !== "driver.firstOnTrack")).toEqual([]);
  });
});

describe("the car an overtake or gap shortcut leaves on track changes no other shortcut", () => {
  /** How long a run is listened to after its publish: the limiter's 2.5 s re-check and a speeding episode fit. */
  const LISTEN_MS = 6000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A press, as the UI and server carry it out with the mock's tick loop
   * running: the setup patch, then each step (ticked at once when it asks,
   * then held while the loop ticks), then the publish, then a listen.
   */
  function press(controller: MockSDKController, shortcut: ScenarioShortcut): void {
    if (shortcut.telemetryPatch) controller.mutateTelemetry(shortcut.telemetryPatch as TelemetryPatch);

    for (const step of shortcut.telemetrySequence ?? []) {
      controller.mutateTelemetry(step.patch as TelemetryPatch);

      if (step.tick === true) controller.tickOnce();

      vi.advanceTimersByTime(step.holdMs ?? 0);
    }

    if (shortcut.event !== undefined) {
      const telemetry = controller.getState().telemetry;

      for (const { event, data } of [
        ...(shortcut.precedingEvents ?? []),
        { event: shortcut.event, data: shortcut.data },
      ]) {
        publish(event, data, telemetry);
      }
    }

    vi.advanceTimersByTime(LISTEN_MS);
  }

  /**
   * Every event on the bus during `shortcut`'s press, from a fresh harness
   * (connected, the given session preset) — after pressing `before` first, or
   * after the same stretch of idle time. `driver.firstOnTrack` is left out:
   * it is the one-shot "first time in the car" event no callout consumes, and
   * whichever button first puts the car on track emits it.
   */
  function eventsOf(
    sessionPreset: string | null,
    before: ScenarioShortcut | null,
    shortcut: ScenarioShortcut,
  ): string[] {
    const bus = initializeEventBus(silentLogger);
    const controller = new MockSDKController();

    if (sessionPreset !== null) {
      const path = join(PACKAGE_ROOT, "presets", "session", `${sessionPreset}.json`);
      controller.setSessionInfo(JSON.parse(readFileSync(path, "utf8")) as SessionInfo);
    }

    controller.setConnected(true);
    initializeSimEventsIracing(bus, controller as unknown as SDKController, silentLogger);
    controller.start();

    if (before === null) vi.advanceTimersByTime(LISTEN_MS);
    else press(controller, before);

    const events: string[] = [];

    for (const name of ALL_EVENT_NAMES) {
      if (name === "driver.firstOnTrack") continue;

      bus.subscribe(name, (ev) => events.push(`${ev.event} ${JSON.stringify(ev.data)}`));
    }

    press(controller, shortcut);
    controller.stop();
    _resetSimEventsIracing();
    _resetEventBus();

    return events;
  }

  // Every wrapped shortcut leaves the same state behind (they share one step),
  // so one of them stands for all.
  const overtake = WRAPPED[0];

  it('leaves "Limiter off on pit road" announcing only its own line, as on its own', () => {
    // The race preset carries a pit speed limit, so a car entering pit road at
    // racing speed would also start a speeding episode here.
    const limiterMissing = SCENARIO_SHORTCUTS.find((s) => s.id === "limiter-missing");

    expect(limiterMissing).toBeDefined();

    if (limiterMissing === undefined) return;

    const alone = eventsOf("race", null, limiterMissing);

    expect(alone).toEqual(["limiter.missing {}", "pitLane.entered {}"]);
    expect(eventsOf("race", overtake, limiterMissing)).toEqual(alone);
  });

  it.each([null, "race"])(
    "leaves every shortcut publishing what it publishes on its own (session preset: %s)",
    (preset) => {
      const changed: string[] = [];

      for (const shortcut of SCENARIO_SHORTCUTS) {
        const alone = eventsOf(preset, null, shortcut);
        const after = eventsOf(preset, overtake, shortcut);

        if (JSON.stringify(after) !== JSON.stringify(alone)) {
          changed.push(`${shortcut.id}\n  alone: ${alone.join(" | ")}\n  after: ${after.join(" | ")}`);
        }
      }

      expect(changed).toEqual([]);
    },
  );
});
