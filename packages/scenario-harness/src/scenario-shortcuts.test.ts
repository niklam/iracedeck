import { _resetEventBus, getEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import { Flags, type SDKController } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { _resetSimEventsIracing, initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import { SCENARIO_SHORTCUTS, type TelemetryStep } from "./scenario-shortcuts.js";

/** The flag events the caution-restart sequence is judged by. */
const WATCHED: readonly SimEventName[] = ["flag.yellow.raised", "flag.green.raised", "flag.yellow.cleared"];

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

function startTranslator(): { controller: MockSDKController; events: SimEventName[] } {
  const controller = new MockSDKController();
  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);

  const events: SimEventName[] = [];

  for (const name of WATCHED) getEventBus().subscribe(name, (ev) => events.push(ev.event));

  // Seed the translator's flag state at "no flags" before the sequence starts.
  controller.tickOnce();

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

describe('the "Caution → restart (green)" shortcut (issue #1127)', () => {
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

  it("drives the translator rather than publishing an event", () => {
    // Publishing `flag.yellow.cleared` would speak the line whatever the
    // translator decided, which is the opposite of what this button asks.
    expect(shortcut?.event).toBeUndefined();
    expect(shortcut?.telemetrySequence).toBeDefined();
  });

  it("ends with the flags cleared, so the harness is not left stuck green", () => {
    const last = shortcut?.telemetrySequence?.at(-1);

    expect(last?.patch).toEqual({ SessionFlags: 0 });
  });

  it("reports the full-course yellow and the green, and no cleared yellow behind them", () => {
    const { controller, events } = startTranslator();

    runSequence(controller, shortcut?.telemetrySequence ?? []);
    // Well past the validated-clear window with the sequence finished — a
    // cleared line arriving late is the same bug a beat later.
    runSequence(controller, [{ patch: {}, holdMs: 10_000 }]);

    expect(events).toEqual(["flag.yellow.raised", "flag.green.raised"]);
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

    expect(events).toEqual(["flag.yellow.raised", "flag.yellow.cleared"]);
  });
});
