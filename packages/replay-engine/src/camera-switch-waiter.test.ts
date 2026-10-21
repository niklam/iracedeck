/**
 * The one camera-switch waiter (#1467, Decision 3): the dial's Track Order
 * turn, its Jump to My Car gesture and every camera key's switch wait behind
 * a position jump as one newest-wins switch for the whole plugin. Moved here
 * with the waiter from `replay-control-track-order-mode.test.ts`.
 */
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  type CameraSwitchJumps,
  type CameraSwitchOptions,
  isCameraSwitchWaiting,
  requestCameraSwitch,
} from "./camera-switch-waiter.js";
import { cancelLapWalks, FASTEST_LAP_WALK_OWNER, LAP_WALK_OWNERS, RACE_START_WALK_OWNER } from "./lap-walk-owners.js";
import { pressReplayCommand, type ReplaySettledOutcome } from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay } from "./replay-command-gate.test-support.js";
import { claimReplayCursor, currentReplayCursorOwner } from "./replay-cursor.js";
import { _configureReplayEngine } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";

let debug: Mock<(message: string) => void>;
let warn: Mock<(message: string) => void>;

/** The engine's root logger: the waiter's `CameraSwitch` scope logs into {@link debug} and {@link warn}. */
const engineRootLogger: ILogger = {
  ...silentLogger,
  createScope: (scope) =>
    scope === "CameraSwitch"
      ? { ...silentLogger, debug: (message) => debug(message), warn: (message) => warn(message) }
      : silentLogger,
};

/** A jump the test ends: `land` resolves the wait settled, `giveUp` at the ceiling, `fail` rejects it. */
function jumpUnderWay(): {
  jumps: CameraSwitchJumps & {
    isUnderWay: Mock<() => boolean>;
    waitToSettle: Mock<() => Promise<ReplaySettledOutcome>>;
  };
  land(): void;
  giveUp(): void;
  fail(error: Error): void;
} {
  let end!: (outcome: ReplaySettledOutcome) => void;
  let reject!: (error: Error) => void;
  const jumps = {
    isUnderWay: vi.fn(() => true),
    waitToSettle: vi.fn(
      () =>
        new Promise<ReplaySettledOutcome>((resolve, rejectWith) => {
          end = resolve;
          reject = rejectWith;
        }),
    ),
  };

  return { jumps, land: () => end("settled"), giveUp: () => end("gave-up"), fail: (error) => reject(error) };
}

/** A quiet replay: nothing under way, and a wait that would settle at once. */
function quiet(): CameraSwitchJumps & {
  isUnderWay: Mock<() => boolean>;
  waitToSettle: Mock<() => Promise<ReplaySettledOutcome>>;
} {
  return {
    isUnderWay: vi.fn(() => false),
    waitToSettle: vi.fn(() => Promise.resolve<ReplaySettledOutcome>("settled")),
  };
}

function options(overrides: Partial<CameraSwitchOptions> = {}): CameraSwitchOptions {
  return {
    by: "dial-track-order",
    label: "Dial track order",
    name: "next car",
    asked: "ticks=1",
    stillValid: () => true,
    ...overrides,
  };
}

describe("requestCameraSwitch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    debug = vi.fn();
    warn = vi.fn();
    resetEngine({ logger: engineRootLogger, now: () => Date.now() });
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  it("sends at once while no jump is under way", async () => {
    const send = vi.fn();
    const jumps = quiet();

    const request = requestCameraSwitch(send, options({ jumps }));

    // At once: in the call itself, not after an await.
    expect(send).toHaveBeenCalledOnce();
    await request;

    expect(jumps.waitToSettle).not.toHaveBeenCalled();
    expect(isCameraSwitchWaiting()).toBe(false);
  });

  it("parks the newest switch behind a jump and sends it when the jumps settle", async () => {
    const jump = jumpUnderWay();
    const first = vi.fn();
    const second = vi.fn();

    const a = requestCameraSwitch(first, options({ jumps: jump.jumps }));
    await vi.advanceTimersByTimeAsync(500);
    const b = requestCameraSwitch(second, options({ jumps: jump.jumps, name: "previous car", asked: "ticks=-1" }));

    expect(isCameraSwitchWaiting()).toBe(true);
    expect(jump.jumps.waitToSettle).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      "Dial track order: ticks=-1; the switch waiting for a jump now goes to the previous car (was next car)",
    );

    jump.land();
    await Promise.all([a, b]);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(isCameraSwitchWaiting()).toBe(false);
  });

  it("sends a switch still waiting after a long jump once it lands", async () => {
    const jump = jumpUnderWay();
    const send = vi.fn();

    const request = requestCameraSwitch(send, options({ jumps: jump.jumps }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "Dial track order: ticks=1; a jump is under way, the next car switch waits for it",
    );

    jump.land();
    await request;

    expect(send).toHaveBeenCalledOnce();
  });

  it("drops the parked switch when the wait does not settle", async () => {
    const jump = jumpUnderWay();
    const send = vi.fn();

    const request = requestCameraSwitch(send, options({ jumps: jump.jumps }));

    jump.giveUp();
    await request;

    expect(send).not.toHaveBeenCalled();
    expect(isCameraSwitchWaiting()).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      "Dial track order: tap dropped (next car), the jump under way did not land within the longest a jump waits",
    );
  });

  it("drops it when the wait throws", async () => {
    const jump = jumpUnderWay();
    const first = vi.fn();
    const second = vi.fn();

    const a = requestCameraSwitch(first, options({ jumps: jump.jumps }));
    const b = requestCameraSwitch(second, options({ jumps: jump.jumps }));

    expect(isCameraSwitchWaiting()).toBe(true);

    jump.fail(new Error("gate gone"));
    await expect(Promise.all([a, b])).resolves.toBeDefined();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(isCameraSwitchWaiting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Dial track order: tap dropped, the wait for the jump under way failed: gate gone",
    );

    // The next switch is one of its own: on a quiet replay it goes out at once.
    const third = vi.fn();

    await requestCameraSwitch(third, options({ jumps: quiet() }));

    expect(third).toHaveBeenCalledOnce();
  });

  it("drops it when the wait throws at once, and leaves the next switch one of its own", async () => {
    const send = vi.fn();
    const throwing: CameraSwitchJumps = {
      isUnderWay: () => true,
      waitToSettle: () => {
        throw new Error("no gate");
      },
    };

    await requestCameraSwitch(send, options({ jumps: throwing }));

    expect(send).not.toHaveBeenCalled();
    expect(isCameraSwitchWaiting()).toBe(false);

    const next = vi.fn();

    await requestCameraSwitch(next, options({ jumps: quiet() }));

    expect(next).toHaveBeenCalledOnce();
  });

  it("drops it when stillValid() is false at the send", async () => {
    const jump = jumpUnderWay();
    const send = vi.fn();
    let valid = true;

    const request = requestCameraSwitch(send, options({ jumps: jump.jumps, stillValid: () => valid }));

    valid = false;
    jump.land();
    await request;

    expect(send).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "Dial track order: tap dropped (next car), the dial left the screen or the replay was left while it waited",
    );
  });

  it("checks stillValid() of the switch that waits, not of the one that started the wait", async () => {
    const jump = jumpUnderWay();
    const first = vi.fn();
    const second = vi.fn();

    const a = requestCameraSwitch(first, options({ jumps: jump.jumps, stillValid: () => false }));
    const b = requestCameraSwitch(second, options({ jumps: jump.jumps, stillValid: () => true }));

    jump.land();
    await Promise.all([a, b]);

    expect(second).toHaveBeenCalledOnce();
  });

  it("a switch asked for after the wait ended is one of its own, not folded into the one going out", async () => {
    const jump = jumpUnderWay();
    let release!: () => void;
    const first = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const second = vi.fn();

    const a = requestCameraSwitch(first, options({ jumps: jump.jumps }));

    jump.land();
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce();

    const b = requestCameraSwitch(second, options({ jumps: quiet() }));

    release();
    await Promise.all([a, b]);

    expect(second).toHaveBeenCalledOnce();
  });

  it("cancels only the lap walks, at the request and at the send", async () => {
    const marker = claimReplayCursor("replay-markers jump");

    await requestCameraSwitch(vi.fn(), options({ by: "next-car", jumps: quiet() }));

    expect(marker.cancelledBy).toBeNull();
    expect(currentReplayCursorOwner()).toBe("replay-markers jump");
    marker.release();

    // A walk standing at the request is cancelled then, under `by`.
    const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);
    const jump = jumpUnderWay();
    const send = vi.fn();
    const request = requestCameraSwitch(send, options({ by: "next-car", jumps: jump.jumps }));

    expect(walk.cancelledBy).toBe("next-car");

    // One that starts while the switch waits is cancelled again when it goes out.
    const later = claimReplayCursor(RACE_START_WALK_OWNER);

    jump.land();
    await request;

    expect(later.cancelledBy).toBe("next-car");
    expect(send).toHaveBeenCalledOnce();
  });

  it("uses the gate's own reads when no jumps are injected", async () => {
    const sim: FakeReplay = fakeReplay({ frame: 2_000 });

    _configureReplayEngine({
      logger: engineRootLogger,
      now: () => Date.now(),
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
    });
    pressReplayCommand({ kind: "jump", frame: 160_000 }, { by: "replay-markers jump", origin: "marker" });

    const send = vi.fn();
    const request = requestCameraSwitch(send, options());

    expect(isCameraSwitchWaiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await request;

    expect(send).toHaveBeenCalledOnce();
    expect(sim.frame()).toBe(160_000);
  });
});

describe("lap-walk owners", () => {
  beforeEach(() => resetEngine());

  it("are the fastest-lap and race-start walks, under the names they claim the cursor with", () => {
    expect(FASTEST_LAP_WALK_OWNER).toBe("jump-to-fastest-lap walk");
    expect(RACE_START_WALK_OWNER).toBe("jump-to-race-start walk");
    expect(LAP_WALK_OWNERS).toEqual([FASTEST_LAP_WALK_OWNER, RACE_START_WALK_OWNER]);
  });

  it("cancelLapWalks cancels a walk's claim and no other owner's", () => {
    const record = claimReplayCursor("jump-to-fastest-lap record jump");

    expect(cancelLapWalks("by")).toBeNull();
    expect(record.cancelledBy).toBeNull();

    const walk = claimReplayCursor(RACE_START_WALK_OWNER);

    expect(cancelLapWalks("by")).toBe(RACE_START_WALK_OWNER);
    expect(walk.cancelledBy).toBe("by");
  });
});
