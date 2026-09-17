import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { Flags, type SDKController, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  initializeSimEventsIracing,
  YELLOW_CLEARED_HOLD_MS,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import { SCENARIO_SHORTCUTS, type TelemetryStep } from "./scenario-shortcuts.js";

type Published = { event: string; data: unknown };

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

function readPreset(kind: "session" | "telemetry", name: string): unknown {
  return JSON.parse(readFileSync(join(PRESETS_DIR, kind, `${name}.json`), "utf8"));
}

/**
 * Drives the real translator with a telemetry sequence, exactly as the UI's
 * shortcut button does: patch, then tick for `holdMs` of simulated time.
 *
 * The ticking inside the hold is not decoration. The validated clear resolves
 * on whichever TICK first finds the hold window elapsed, so a sequence that
 * only advanced the clock would never let it fire — and the assertion that no
 * cleared event arrives would pass for the wrong reason. The positive control
 * below is what proves it can.
 */
function runSequence(controller: MockSDKController, steps: readonly TelemetryStep[]): void {
  const TICK_MS = 100;

  for (const step of steps) {
    controller.mutateTelemetry(step.patch as TelemetryPatch);
    controller.tickOnce();

    for (let elapsed = 0; elapsed < (step.holdMs ?? 0); elapsed += TICK_MS) {
      vi.advanceTimersByTime(TICK_MS);
      controller.tickOnce();
    }
  }
}

/**
 * Starts the translator the way a tester sets the harness up before pressing
 * the button — the race session preset and the hot-lap telemetry preset, as
 * the shortcut's description asks — then records every flag and start-light
 * event from that point on. Whatever the presets themselves produce on the
 * seeding tick is not the button's doing, so it is not recorded.
 */
function startTranslator(): { controller: MockSDKController; events: Published[] } {
  const controller = new MockSDKController();
  controller.setSessionInfo(readPreset("session", "race") as SessionInfo);
  controller.mutateTelemetry(readPreset("telemetry", "hot-lap") as Partial<TelemetryData>);
  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);

  // Seed the translator's diff state at the presets, with no flag shown.
  controller.tickOnce();

  const events: Published[] = [];

  for (const name of ALL_EVENT_NAMES) {
    if (!name.startsWith("flag.") && !name.startsWith("startLight.")) continue;

    getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
  }

  return { controller, events };
}

describe("SCENARIO_SHORTCUTS", () => {
  it("gives every shortcut a unique id", () => {
    const ids = SCENARIO_SHORTCUTS.map((s) => s.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every shortcut something to drive — a bus event or a telemetry sequence", () => {
    for (const shortcut of SCENARIO_SHORTCUTS) {
      expect(shortcut.event ?? shortcut.telemetrySequence, `shortcut "${shortcut.id}" drives nothing`).toBeDefined();
    }
  });
});

describe('the "Caution → restart" shortcut (issue #1127)', () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "flag-caution-restart");
  const steps = shortcut?.telemetrySequence ?? [];

  it("drives the translator rather than publishing an event", () => {
    // Publishing `flag.yellow.cleared` would speak the line whatever the
    // translator decided, which is the opposite of what this button asks.
    expect(shortcut?.event).toBeUndefined();
    expect(shortcut?.telemetrySequence).toBeDefined();
  });

  it("replays the SessionFlags of the caution and restart captured at an oval, in order", () => {
    // `local/telemetry-watch-20260917-191825-092.jsonl` (Homestead-Miami, AI
    // race, `!yellow`, double-file restart). `>>> 0` reads the patch back as
    // the unsigned value the capture's hex is written in — StartGo is the sign
    // bit, so the restart patch is a negative number on the wire.
    expect(steps.map((s) => (s.patch.SessionFlags as number) >>> 0)).toEqual([
      0x10048000, // CautionWaving
      0x10044000, // Caution
      0x10044200, // Caution + OneLapToGreen
      0x10044600, // Caution + OneLapToGreen + GreenHeld
      0x80040004, // Green + StartGo — the restart
      0x10040004, // Green
      0x10040000, // no flag shown
    ]);
    expect(steps.every((s) => Object.keys(s.patch).length === 1)).toBe(true);
  });

  it("stays under half a minute, and listens past the validated-clear window after the restart", () => {
    const holdOf = (list: readonly TelemetryStep[]): number => list.reduce((sum, s) => sum + (s.holdMs ?? 0), 0);
    const restartAt = steps.findIndex((s) => ((s.patch.SessionFlags as number) & Flags.StartGo) !== 0);

    expect(restartAt).toBeGreaterThan(0);
    expect(holdOf(steps)).toBeLessThanOrEqual(30_000);
    // The cleared line this button exists to NOT hear would land this long
    // after the restart tick, so the button has to still be listening then.
    expect(holdOf(steps.slice(restartAt))).toBeGreaterThan(YELLOW_CLEARED_HOLD_MS);
  });

  it("reports the caution, the full-course yellow, the green-held and the start signal's go — and nothing after the restart", () => {
    const { controller, events } = startTranslator();

    runSequence(controller, steps);
    // Well past the validated-clear window with the sequence finished — a
    // cleared line arriving late is the same bug a beat later.
    runSequence(controller, [{ patch: {}, holdMs: 10_000 }]);

    // No `flag.green.raised`: the restart carries iRacing's start signal, so
    // the green is suppressed like a race start's and the start lights' go
    // line is what plays. No `flag.yellow.cleared`: that is issue #1127.
    expect(events).toEqual([
      { event: "flag.caution-waving.raised", data: {} },
      { event: "flag.yellow.raised", data: { scope: "full" } },
      { event: "flag.green-held.raised", data: {} },
      { event: "startLight.start-go.raised", data: {} },
    ]);
  });

  it("ends with no flag shown, so a second press plays the same sequence again", () => {
    const { controller, events } = startTranslator();

    runSequence(controller, steps);
    const firstPress = events.splice(0);

    runSequence(controller, steps);

    expect(events).toEqual(firstPress);
    expect(firstPress).not.toEqual([]);
  });

  it("positive control: a LOCAL yellow driven the same way still reports its clear", () => {
    // Without this the assertion above would be satisfied by a rig that can
    // never observe `flag.yellow.cleared` at all — a broken harness and a
    // fixed translator look identical from the negative test alone.
    const { controller, events } = startTranslator();

    runSequence(controller, [
      { patch: { SessionFlags: Flags.Yellow }, holdMs: 1000 },
      { patch: { SessionFlags: 0 }, holdMs: 10_000 },
    ]);

    expect(events).toEqual([
      { event: "flag.yellow.raised", data: { scope: "local" } },
      { event: "flag.yellow.cleared", data: {} },
    ]);
  });
});
