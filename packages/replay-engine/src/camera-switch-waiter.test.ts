/**
 * The one camera-switch waiter (#1467, Decision 3): the dial's Track Order
 * turn, its Jump to My Car gesture and every camera key's switch wait behind
 * a position jump as one newest-wins switch for the whole plugin. Moved here
 * with the waiter from `replay-control-track-order-mode.test.ts`.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  type CameraSwitchJumps,
  type CameraSwitchOptions,
  isCameraSwitchWaiting,
  requestCameraSwitch,
  YIELDING_SWITCH_MAX_WAIT_MS,
} from "./camera-switch-waiter.js";
import { holdLapPressSlot } from "./lap-press.js";
import {
  cancelLapWalks,
  FASTEST_LAP_WALK_OWNER,
  interruptLapWalks,
  LAP_WALK_OWNERS,
  RACE_START_WALK_OWNER,
} from "./lap-walk-owners.js";
import {
  claimReplayCursorForJump,
  closeReplayJump,
  isReplayJumpSequenceOpen,
  openReplayJump,
  pressReplayCommand,
  replayJumpLanding,
  type ReplaySettledOutcome,
  sendReplayJumpSeek,
} from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay } from "./replay-command-gate.test-support.js";
import {
  capturedJumpSpeed,
  claimReplayCursor,
  currentReplayCursorOwner,
  onReplayCursorTaken,
  recordCapturedJumpSpeed,
  type ReplayCursorClaim,
} from "./replay-cursor.js";
import { _configureReplayEngine } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { watchReplayLeft } from "./replay-left.test-support.js";
import { pendingReplaySearch, queueReplaySearch } from "./replay-search-queue.js";
import { resolveLiveSpeed } from "./replay-speed-state.js";
import { noteReplaySpeedSent } from "./replay-speed-state.test-support.js";
import { REPLAY_JUMP_MAX_WAIT_MS, STABILIZATION_POLL_INTERVAL_MS } from "./replay-timing.js";

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
    surface: "the dial",
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
    // A replay on screen: outside one every switch goes out at once.
    resetEngine({ logger: engineRootLogger, now: () => Date.now(), inReplay: () => true });
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  describe("leaving the replay (#1428 / #1435 second read)", () => {
    let inReplay: boolean;

    beforeEach(() => {
      inReplay = true;
      resetEngine({ logger: engineRootLogger, now: () => Date.now(), inReplay: () => inReplay });
    });

    /** The engine's departure event, as its watch emits it on a disconnect (which is never held). */
    function leaveReplay(): void {
      // A connected tick with telemetry first: the watch counts a disconnect only after one.
      const watched = watchReplayLeft({ replayState: () => ({ inReplay }), telemetry: () => ({}) as TelemetryData });

      inReplay = false;
      watched.tick(null, false);
    }

    it("still waits behind a long seek whose replay state reads false, with no departure", () => {
      // An in-session replay reads "not in a replay" a second into a long seek:
      // that is not a departure, and the switch must not go out into the seek.
      inReplay = false;

      const send = vi.fn();
      const jump = jumpUnderWay();

      void requestCameraSwitch(send, options({ jumps: jump.jumps }));

      expect(send).not.toHaveBeenCalled();
      expect(isCameraSwitchWaiting()).toBe(true);
    });

    it("sends at once once the replay has been left, whatever the jump reads say", async () => {
      leaveReplay();

      const send = vi.fn();
      const jump = jumpUnderWay();

      const request = requestCameraSwitch(send, options({ jumps: jump.jumps }));

      // A jump left standing by leaving the replay must not park a live
      // press, which the replay's absence would then drop.
      expect(send).toHaveBeenCalledOnce();
      await request;

      expect(jump.jumps.waitToSettle).not.toHaveBeenCalled();
      expect(isCameraSwitchWaiting()).toBe(false);
    });

    it("waits behind a jump again once a replay is back on screen", () => {
      leaveReplay();
      inReplay = true;

      const send = vi.fn();
      const jump = jumpUnderWay();

      void requestCameraSwitch(send, options({ jumps: jump.jumps }));

      // Back in a replay the departure no longer stands, even when the state
      // reads false again during a later seek.
      inReplay = false;
      expect(send).not.toHaveBeenCalled();
      expect(isCameraSwitchWaiting()).toBe(true);
    });
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

  it("logs a send that fails and resolves every request waiting on it, at once or behind a jump", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("keystroke refused")));

    await expect(requestCameraSwitch(failing, options({ jumps: quiet() }))).resolves.toBeUndefined();

    const jump = jumpUnderWay();
    const a = requestCameraSwitch(vi.fn(), options({ jumps: jump.jumps }));
    const b = requestCameraSwitch(failing, options({ jumps: jump.jumps }));

    jump.land();

    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Dial track order: the next car switch failed: keystroke refused");
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

  it("interrupts only the lap walks, at the request and at the send, and cancels none (#1428 / #1435)", async () => {
    const marker = claimReplayCursor("replay-markers jump");

    await requestCameraSwitch(vi.fn(), options({ by: "next-car", jumps: quiet() }));

    expect(marker.cancelledBy).toBeNull();
    expect(marker.interruptedBy).toBeNull();
    expect(currentReplayCursorOwner()).toBe("replay-markers jump");
    marker.release();

    // A walk standing at the request is interrupted then, under `by`: it keeps the cursor.
    const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);
    const jump = jumpUnderWay();
    const send = vi.fn();
    const request = requestCameraSwitch(send, options({ by: "next-car", jumps: jump.jumps }));

    expect(walk.interruptedBy).toBe("next-car");
    expect(walk.cancelledBy).toBeNull();
    expect(currentReplayCursorOwner()).toBe(FASTEST_LAP_WALK_OWNER);

    jump.land();
    await request;

    expect(send).toHaveBeenCalledOnce();
  });

  it("a lap press drops a switch still waiting from before it; one asked for after the press interrupts its walk (#1428 / #1435)", async () => {
    const sim = fakeReplay({ frame: 2_000 });

    _configureReplayEngine({
      logger: engineRootLogger,
      now: () => Date.now(),
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
    });

    // A switch parked behind an earlier jump (a marker, a Frame Jog spin).
    const jump = jumpUnderWay();
    const before = vi.fn();
    const parked = requestCameraSwitch(before, options({ by: "next-car", jumps: jump.jumps }));

    expect(isCameraSwitchWaiting()).toBe(true);

    // Then a Jump to Fastest Lap press: the newer press drops it.
    const walk: { claim: ReplayCursorClaim | null } = { claim: null };
    let finish!: () => void;
    const press = holdLapPressSlot(
      "ctx-fastest",
      { owner: FASTEST_LAP_WALK_OWNER, noun: "walk", label: "Jump to fastest lap" },
      (pressJump) => {
        walk.claim = pressJump.claim;

        return new Promise<void>((resolve) => (finish = resolve));
      },
    );

    expect(isCameraSwitchWaiting()).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      "Dial track order: tap dropped (next car), a Jump to fastest lap press came after it",
    );

    jump.land();
    await parked;

    // It never goes out, and never interrupts the newer walk.
    expect(before).not.toHaveBeenCalled();
    expect(walk.claim?.interruptedBy).toBeNull();

    // A switch asked for after the press interrupts the walk, and waits for the press to wind down.
    const after = vi.fn();
    const request = requestCameraSwitch(after, options({ by: "next-car", jumps: quiet() }));

    expect(walk.claim?.interruptedBy).toBe("next-car");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(after).not.toHaveBeenCalled();

    finish();
    await press;
    await vi.advanceTimersByTimeAsync(100);
    await request;

    expect(after).toHaveBeenCalledOnce();
  });

  it("a lap press ends the wait it dropped: a switch asked for during its walk waits on its own (#1428 / #1435)", async () => {
    const sim = fakeReplay({ frame: 2_000 });

    _configureReplayEngine({
      logger: engineRootLogger,
      now: () => Date.now(),
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
    });

    // A switch parked behind an earlier jump, with jump reads of its own, a long time ago.
    const jump = jumpUnderWay();
    const before = vi.fn();
    const parked = requestCameraSwitch(before, options({ by: "next-car", jumps: jump.jumps }));

    await vi.advanceTimersByTimeAsync(100_000);

    // Then a Jump to Fastest Lap press, which drops it.
    let finish!: () => void;
    const press = holdLapPressSlot(
      "ctx-fastest",
      { owner: FASTEST_LAP_WALK_OWNER, noun: "walk", label: "Jump to fastest lap" },
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    // A switch asked for during the walk, with the gate's own reads: it interrupts the walk and waits for its
    // way back as a wait of its own, not folded into the dropped one's.
    const after = vi.fn();
    const request = requestCameraSwitch(after, options({ by: "next-car", name: "my car", asked: "Jump to My Car" }));

    expect(debug).toHaveBeenCalledWith(
      "Dial track order: Jump to My Car; a jump is under way, the my car switch waits for it",
    );
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("the switch waiting for a jump now goes to"));

    // Past the dropped wait's ceiling, counted from its own request, and well inside this one's.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(after).not.toHaveBeenCalled();

    // The walk puts the replay back and the press ends: the switch goes out, once.
    finish();
    await press;
    await vi.advanceTimersByTimeAsync(500);
    await request;

    expect(after).toHaveBeenCalledOnce();
    // The dropped wait's own jump reads were never asked again.
    expect(jump.jumps.waitToSettle).toHaveBeenCalledOnce();

    // The dropped wait ends when its jump lands, and sends nothing: not its switch, nor the newer one again.
    jump.land();
    await parked;

    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    expect(isCameraSwitchWaiting()).toBe(false);
  });

  it("an angle-only switch (interruptsWalks: false) leaves a walk alone", async () => {
    const walk = claimReplayCursor(RACE_START_WALK_OWNER);
    const send = vi.fn();

    await requestCameraSwitch(send, options({ by: "cycle-camera", interruptsWalks: false, jumps: quiet() }));

    expect(send).toHaveBeenCalledOnce();
    expect(walk.interruptedBy).toBeNull();
    expect(walk.cancelledBy).toBeNull();
    expect(currentReplayCursorOwner()).toBe(RACE_START_WALK_OWNER);
  });

  describe("what holds a switch beside the jump reads (#1428 / #1435)", () => {
    /** Telemetry for a paused replay on `frame`, nothing under way. */
    function quietReplay(frame: number): FakeReplay {
      const sim = fakeReplay({ frame });

      _configureReplayEngine({
        logger: engineRootLogger,
        now: () => Date.now(),
        replay: () => sim.replay,
        readTelemetry: () => sim.telemetry(),
        inReplay: () => true,
        connected: () => true,
      });

      return sim;
    }

    it("a switch asked for between a jump's landing and its end() waits for the end", async () => {
      const sim = quietReplay(2_000);
      const claim = claimReplayCursorForJump("replay-markers jump");
      const handle = openReplayJump(claim, {
        frame: 50_000,
        origin: "marker",
        telemetry: sim.telemetry(),
        sendsPositionJump: true,
      });

      expect(sendReplayJumpSeek(handle)).toBe("sent");
      await vi.advanceTimersByTimeAsync(2_000);

      // Landed and read back, its own step after the landing still to run: no jump reads as under way.
      expect(sim.frame()).toBe(50_000);
      expect(replayJumpLanding(handle, sim.telemetry()).status).toBe("read-back");
      expect(isReplayJumpSequenceOpen()).toBe(true);

      const send = vi.fn();
      const request = requestCameraSwitch(send, options());

      expect(isCameraSwitchWaiting()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).not.toHaveBeenCalled();

      closeReplayJump(handle, "landed");
      claim.release();
      expect(isReplayJumpSequenceOpen()).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      await request;

      expect(send).toHaveBeenCalledOnce();
      expect(sim.thrown).toBe(0);
    });

    it("a jump to the frame on screen holds it until its end() too", async () => {
      const sim = quietReplay(2_000);
      const claim = claimReplayCursorForJump("replay-markers jump");
      const handle = openReplayJump(claim, {
        frame: 2_000,
        origin: "marker",
        telemetry: sim.telemetry(),
        sendsPositionJump: true,
      });

      // It records no target, so the open sequence is all that holds the switch.
      expect(isReplayJumpSequenceOpen()).toBe(true);

      const send = vi.fn();
      const request = requestCameraSwitch(send, options());

      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).not.toHaveBeenCalled();

      closeReplayJump(handle, "landed");
      await vi.advanceTimersByTimeAsync(500);
      await request;

      expect(send).toHaveBeenCalledOnce();
    });

    it("a jump sequence with no frame (a paced search's run) does not hold it", async () => {
      const sim = quietReplay(2_000);
      const claim = claimReplayCursorForJump("dial-lap search");

      openReplayJump(claim, { origin: "dial", telemetry: sim.telemetry(), sendsPositionJump: false });

      expect(isReplayJumpSequenceOpen()).toBe(false);

      const send = vi.fn();

      await requestCameraSwitch(send, options());

      expect(send).toHaveBeenCalledOnce();
    });

    it("gives up at the ceiling a jump sequence never ended by", async () => {
      const sim = quietReplay(2_000);
      const claim = claimReplayCursorForJump("replay-markers jump");

      openReplayJump(claim, { frame: 2_000, origin: "marker", telemetry: sim.telemetry(), sendsPositionJump: true });

      const send = vi.fn();
      const request = requestCameraSwitch(send, options());

      await vi.advanceTimersByTimeAsync(REPLAY_JUMP_MAX_WAIT_MS + 1_000);
      await request;

      expect(send).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith(
        "Dial track order: tap dropped (next car), the jump under way did not land within the longest a jump waits",
      );
    });

    it("an injected jump read gets the holds too", async () => {
      const sim = quietReplay(2_000);
      const claim = claimReplayCursorForJump("replay-markers jump");
      const handle = openReplayJump(claim, {
        frame: 2_000,
        origin: "marker",
        telemetry: sim.telemetry(),
        sendsPositionJump: true,
      });
      const jumps = quiet();
      const send = vi.fn();
      const request = requestCameraSwitch(send, options({ jumps }));

      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).not.toHaveBeenCalled();

      closeReplayJump(handle, "landed");
      await vi.advanceTimersByTimeAsync(100);
      await request;

      expect(send).toHaveBeenCalledOnce();
      expect(jumps.waitToSettle).toHaveBeenCalledOnce();
    });
  });

  describe("a yielding switch: an automation's gives way to a user's (#1656)", () => {
    /** Auto Group on Car Change's request, as `auto-group.ts` makes it. */
    function automatic(overrides: Partial<CameraSwitchOptions> = {}): CameraSwitchOptions {
      return options({
        by: "camera-controls auto-group",
        yields: true,
        interruptsWalks: false,
        label: "Camera controls",
        name: "auto group",
        asked: "camera moved to another car",
        surface: "the auto group",
        ...overrides,
      });
    }

    /** The engine over a quiet fake replay, for the tests that need the real presses, searches and gate. */
    function engineOver(sim: FakeReplay): FakeReplay {
      _configureReplayEngine({
        logger: engineRootLogger,
        now: () => Date.now(),
        replay: () => sim.replay,
        readTelemetry: () => sim.telemetry(),
        inReplay: () => true,
        connected: () => true,
      });

      return sim;
    }

    /** A Jump to Fastest Lap press whose walk runs until `finish()`. */
    function lapPress(): { press: Promise<unknown>; finish: () => void; claim: () => ReplayCursorClaim | null } {
      let claim: ReplayCursorClaim | null = null;
      let finish!: () => void;
      const press = holdLapPressSlot(
        "ctx-fastest",
        { owner: FASTEST_LAP_WALK_OWNER, noun: "walk", label: "Jump to fastest lap" },
        (pressJump) => {
          claim = pressJump.claim;

          return new Promise<void>((resolve) => (finish = resolve));
        },
      );

      return { press, finish: () => finish(), claim: () => claim };
    }

    it("never replaces a waiting switch that does not yield: it is dropped, at once", async () => {
      const jump = jumpUnderWay();
      const user = vi.fn();
      const auto = vi.fn();

      const a = requestCameraSwitch(user, options({ jumps: jump.jumps }));
      let dropped = false;
      const b = requestCameraSwitch(auto, automatic({ jumps: jump.jumps })).then(() => (dropped = true));

      await vi.advanceTimersByTimeAsync(0);
      expect(dropped).toBe(true);
      expect(isCameraSwitchWaiting()).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        "Camera controls: automatic switch dropped (auto group), the next car switch waiting for a jump goes first",
      );
      expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("now goes to the auto group"));

      jump.land();
      await Promise.all([a, b]);

      expect(user).toHaveBeenCalledOnce();
      expect(auto).not.toHaveBeenCalled();
      expect(jump.jumps.waitToSettle).toHaveBeenCalledOnce();
    });

    it("a switch that does not yield replaces a waiting yielding one and waits on its own terms", async () => {
      const autoJump = jumpUnderWay();
      const auto = vi.fn();
      const a = requestCameraSwitch(auto, automatic({ jumps: autoJump.jumps }));

      expect(isCameraSwitchWaiting()).toBe(true);

      const userJump = jumpUnderWay();
      const user = vi.fn();
      const b = requestCameraSwitch(user, options({ jumps: userJump.jumps }));

      expect(debug).toHaveBeenCalledWith(
        "Camera controls: automatic switch dropped (auto group), the next car switch asked for after it goes instead",
      );
      // Its own wait, with its own jump reads: not the "now goes to" of a switch folded into the waiting one's.
      expect(debug).toHaveBeenCalledWith(
        "Dial track order: ticks=1; a jump is under way, the next car switch waits for it",
      );
      expect(userJump.jumps.waitToSettle).toHaveBeenCalledOnce();

      userJump.land();
      await b;

      expect(user).toHaveBeenCalledOnce();
      expect(isCameraSwitchWaiting()).toBe(false);

      // The yielding switch's wait ends when its jump lands, and sends nothing.
      autoJump.land();
      await a;

      expect(auto).not.toHaveBeenCalled();
      expect(user).toHaveBeenCalledOnce();
    });

    it("a switch that does not yield goes out at once over a yielding one when nothing it waits for is under way", async () => {
      const jump = jumpUnderWay();
      const auto = vi.fn();
      const a = requestCameraSwitch(auto, automatic({ jumps: jump.jumps }));
      const user = vi.fn();

      void requestCameraSwitch(user, options({ jumps: quiet() }));

      expect(user).toHaveBeenCalledOnce();
      expect(isCameraSwitchWaiting()).toBe(false);

      jump.land();
      await a;

      expect(auto).not.toHaveBeenCalled();
    });

    it("the newest yielding switch replaces a waiting yielding one", async () => {
      const jump = jumpUnderWay();
      const first = vi.fn();
      const second = vi.fn();

      const a = requestCameraSwitch(first, automatic({ jumps: jump.jumps }));
      const b = requestCameraSwitch(second, automatic({ jumps: jump.jumps }));

      jump.land();
      await Promise.all([a, b]);

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
      expect(jump.jumps.waitToSettle).toHaveBeenCalledOnce();
    });

    it("waits for a whole lap press, its walk included, and interrupts no walk", async () => {
      engineOver(fakeReplay({ frame: 2_000 }));

      const walk = lapPress();

      // An angle-only switch that does not yield goes out at once during the walk's search.
      const angle = vi.fn();

      await requestCameraSwitch(angle, options({ by: "cycle-camera", interruptsWalks: false }));
      expect(angle).toHaveBeenCalledOnce();

      // A yielding one waits, and interrupts the walk even when it asks to.
      const auto = vi.fn();
      const request = requestCameraSwitch(auto, automatic({ interruptsWalks: true }));

      expect(isCameraSwitchWaiting()).toBe(true);
      expect(walk.claim()?.interruptedBy).toBeNull();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(auto).not.toHaveBeenCalled();

      walk.finish();
      await walk.press;
      await vi.advanceTimersByTimeAsync(500);
      await request;

      expect(auto).toHaveBeenCalledOnce();
      expect(walk.claim()?.interruptedBy).toBeNull();
    });

    it("a wait ended under it stops polling at its next read, and sends nothing (second read)", async () => {
      engineOver(fakeReplay({ frame: 2_000 }));

      const walk = lapPress();
      const autoJumps = quiet();
      const auto = vi.fn();
      let ended = false;
      const request = requestCameraSwitch(auto, automatic({ jumps: autoJumps })).then(() => (ended = true));

      // While it is the current wait, the press holds it.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(isCameraSwitchWaiting()).toBe(true);
      expect(ended).toBe(false);

      // A user's switch ends its wait: the run stops at its next read, with the press still holding.
      const user = vi.fn();

      await requestCameraSwitch(user, options({ by: "cycle-camera", interruptsWalks: false, jumps: quiet() }));
      expect(user).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(STABILIZATION_POLL_INTERVAL_MS);
      expect(ended).toBe(true);
      expect(autoJumps.waitToSettle).not.toHaveBeenCalled();

      // Nothing of it runs once the press ends: no wait for the jumps, no send.
      walk.finish();
      await walk.press;
      await vi.advanceTimersByTimeAsync(500);
      await request;

      expect(autoJumps.waitToSettle).not.toHaveBeenCalled();
      expect(auto).not.toHaveBeenCalled();
      expect(user).toHaveBeenCalledOnce();
    });

    it("keeps waiting through a lap press that starts while it waits, and goes out after it", async () => {
      engineOver(fakeReplay({ frame: 2_000 }));

      const jump = jumpUnderWay();
      const auto = vi.fn();
      const request = requestCameraSwitch(auto, automatic({ jumps: jump.jumps }));
      const walk = lapPress();

      expect(isCameraSwitchWaiting()).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        "Camera controls: the auto group switch waits for the Jump to fastest lap press too",
      );
      expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));

      // Its jump lands, but the press still holds it.
      jump.jumps.waitToSettle.mockImplementation(() => Promise.resolve<ReplaySettledOutcome>("settled"));
      jump.land();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(auto).not.toHaveBeenCalled();

      walk.finish();
      await walk.press;
      await vi.advanceTimersByTimeAsync(500);
      await request;

      expect(auto).toHaveBeenCalledOnce();
      expect(jump.jumps.waitToSettle).toHaveBeenCalledTimes(2);
    });

    it("waits for a paced search's run, which holds no switch that does not yield", async () => {
      engineOver(fakeReplay({ frame: 2_000, searches: { nextLap: (from) => from + 3_000 }, minSeekMs: 1_000 }));
      queueReplaySearch({ target: "lap", ticks: 3, origin: "dial", owner: "replay-control-dial lap" });
      await vi.advanceTimersByTimeAsync(10);

      expect(pendingReplaySearch()).not.toBeNull();

      let searchAtSend: unknown = "unsent";
      const auto = vi.fn(() => {
        searchAtSend = pendingReplaySearch();
      });
      const request = requestCameraSwitch(auto, automatic());

      expect(isCameraSwitchWaiting()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(auto).not.toHaveBeenCalled();

      for (let waited = 0; waited < 60_000 && pendingReplaySearch() !== null; waited += 100) {
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(pendingReplaySearch()).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      await request;

      expect(auto).toHaveBeenCalledOnce();
      expect(searchAtSend).toBeNull();
    });

    it("is not dropped at the ceiling of one jump, only at its own", async () => {
      engineOver(fakeReplay({ frame: 2_000 }));
      lapPress();

      const auto = vi.fn();
      const request = requestCameraSwitch(auto, automatic());

      await vi.advanceTimersByTimeAsync(REPLAY_JUMP_MAX_WAIT_MS + 1_000);
      expect(isCameraSwitchWaiting()).toBe(true);
      expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));

      await vi.advanceTimersByTimeAsync(YIELDING_SWITCH_MAX_WAIT_MS - REPLAY_JUMP_MAX_WAIT_MS);
      await request;

      expect(auto).not.toHaveBeenCalled();
      expect(isCameraSwitchWaiting()).toBe(false);
      expect(debug).toHaveBeenCalledWith(
        "Camera controls: automatic switch dropped (auto group), the replay was still busy at the longest it waits",
      );
    });

    it("its ceiling is a full paced search waited for at the ceiling of each jump", () => {
      expect(YIELDING_SWITCH_MAX_WAIT_MS).toBe(10 * REPLAY_JUMP_MAX_WAIT_MS);
    });

    it("is dropped when stillValid() is false once the wait ends", async () => {
      const jump = jumpUnderWay();
      const auto = vi.fn();
      let valid = true;
      const request = requestCameraSwitch(auto, automatic({ jumps: jump.jumps, stillValid: () => valid }));

      valid = false;
      jump.land();
      await request;

      expect(auto).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith(
        "Camera controls: automatic switch dropped (auto group), the auto group no longer asks for it",
      );
    });

    describe("a user's switch that went out after its trigger (triggeredMsAgo, second read)", () => {
      /** A user's angle switch, sent at once on a quiet replay: Cycle Camera's. */
      async function userSwitch(): Promise<Mock<() => void>> {
        const user = vi.fn();

        await requestCameraSwitch(user, options({ by: "cycle-camera", name: "cycle camera", jumps: quiet() }));
        expect(user).toHaveBeenCalledOnce();

        return user;
      }

      it("drops it at the request: a switch sent at the trigger's moment or after it", async () => {
        // The car changes at 1_000_000; the user cycles the camera at once, at the same moment.
        await userSwitch();
        await vi.advanceTimersByTimeAsync(250);

        const auto = vi.fn();

        await requestCameraSwitch(auto, automatic({ jumps: quiet(), triggeredMsAgo: 250 }));

        expect(auto).not.toHaveBeenCalled();
        expect(isCameraSwitchWaiting()).toBe(false);
        expect(debug).toHaveBeenCalledWith(
          "Camera controls: automatic switch dropped (auto group), the cycle camera switch went out after what asked for it",
        );
      });

      it("drops it at the request without touching the switch waiting in the slot", async () => {
        await userSwitch();
        await vi.advanceTimersByTimeAsync(100);

        // A yielding switch that gave no trigger waits behind a jump.
        const jump = jumpUnderWay();
        const first = vi.fn();
        const a = requestCameraSwitch(first, automatic({ jumps: jump.jumps }));

        await vi.advanceTimersByTimeAsync(150);

        const second = vi.fn();

        await requestCameraSwitch(second, automatic({ jumps: jump.jumps, triggeredMsAgo: 250 }));

        expect(second).not.toHaveBeenCalled();
        expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("now goes to"));

        jump.land();
        await a;

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
      });

      it("sends it when the user's switch went out before its trigger", async () => {
        await userSwitch();
        await vi.advanceTimersByTimeAsync(251);

        const auto = vi.fn();

        await requestCameraSwitch(auto, automatic({ jumps: quiet(), triggeredMsAgo: 250 }));

        expect(auto).toHaveBeenCalledOnce();
      });

      it("sends it when it gives no trigger, or one that is not a finite number", async () => {
        await userSwitch();
        await vi.advanceTimersByTimeAsync(100);

        const sent: number[] = [];

        for (const [i, triggeredMsAgo] of [undefined, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
          await requestCameraSwitch(() => sent.push(i), automatic({ jumps: quiet(), triggeredMsAgo }));
        }

        expect(sent).toEqual([0, 1, 2]);
      });

      it("never drops a switch that does not yield, whatever it says", async () => {
        await userSwitch();

        const later = vi.fn();

        await requestCameraSwitch(later, options({ jumps: quiet(), triggeredMsAgo: 10_000 }));

        expect(later).toHaveBeenCalledOnce();
      });

      it("drops one that waited once a user's switch has gone out since its trigger, and sends nothing for it", async () => {
        const jump = jumpUnderWay();
        const auto = vi.fn();
        const request = requestCameraSwitch(auto, automatic({ jumps: jump.jumps, triggeredMsAgo: 250 }));

        expect(isCameraSwitchWaiting()).toBe(true);
        await vi.advanceTimersByTimeAsync(400);

        // The user's switch ends this one's wait as it goes out; the waiter's
        // send-time check of the trigger is the second line behind that.
        const user = await userSwitch();

        jump.land();
        await request;

        expect(auto).not.toHaveBeenCalled();
        expect(user).toHaveBeenCalledOnce();
        expect(isCameraSwitchWaiting()).toBe(false);
      });

      it("sends one that waited when the only user's switch went out before its trigger", async () => {
        await userSwitch();
        await vi.advanceTimersByTimeAsync(300);

        const jump = jumpUnderWay();
        const auto = vi.fn();
        const request = requestCameraSwitch(auto, automatic({ jumps: jump.jumps, triggeredMsAgo: 250 }));

        expect(isCameraSwitchWaiting()).toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);
        jump.land();
        await request;

        expect(auto).toHaveBeenCalledOnce();
      });

      it("counts a switch only once it went out: one still waiting, or dropped, does not drop it", async () => {
        const jump = jumpUnderWay();
        const user = vi.fn();
        const a = requestCameraSwitch(user, options({ jumps: jump.jumps, stillValid: () => false }));

        // The user's switch waits, so this one is dropped by the slot rule, not by a send.
        await requestCameraSwitch(vi.fn(), automatic({ jumps: jump.jumps, triggeredMsAgo: 250 }));
        expect(debug).toHaveBeenCalledWith(
          "Camera controls: automatic switch dropped (auto group), the next car switch waiting for a jump goes first",
        );

        // The user's switch is dropped at its send (its key left): it never went out.
        jump.land();
        await a;
        expect(user).not.toHaveBeenCalled();

        const auto = vi.fn();

        await requestCameraSwitch(auto, automatic({ jumps: quiet(), triggeredMsAgo: 250 }));

        expect(auto).toHaveBeenCalledOnce();
      });
    });

    describe("a trigger seen late, with its earliest moment (earliestTriggerMsAgo)", () => {
      /**
       * The timeline of a car change Auto Group's 200 ms read notices in a
       * paused replay. At 1_000_000 the read still shows the old car; the car
       * changes at +20; the read at +200 sees it; the settle timer asks at
       * +450. The trigger was 250 ms before the request, the earliest it can
       * have been 450 ms before it.
       */
      const TRIGGERED_MS_AGO = 250;
      const EARLIEST_MS_AGO = 450;

      /** A user's switch of the angle only, sent at once: Cycle Camera's. */
      async function angleSwitch(): Promise<void> {
        await requestCameraSwitch(
          vi.fn(),
          options({ by: "cycle-camera", name: "cycle camera", interruptsWalks: false, jumps: quiet() }),
        );
      }

      /** A user's switch of the car, sent at once: Next Car's. */
      async function carSwitch(): Promise<void> {
        await requestCameraSwitch(vi.fn(), options({ jumps: quiet() }));
      }

      /** Auto Group's request at +450, with both ages unless overridden. */
      async function autoAt450(overrides: Partial<CameraSwitchOptions> = {}): Promise<Mock<() => void>> {
        const auto = vi.fn();

        await vi.advanceTimersByTimeAsync(1_000_450 - Date.now());
        await requestCameraSwitch(
          auto,
          automatic({
            jumps: quiet(),
            triggeredMsAgo: TRIGGERED_MS_AGO,
            earliestTriggerMsAgo: EARLIEST_MS_AGO,
            ...overrides,
          }),
        );

        return auto;
      }

      it("drops it when the user picked an angle after the car changed but before the read saw it", async () => {
        await vi.advanceTimersByTimeAsync(100);
        await angleSwitch();

        const auto = await autoAt450();

        expect(auto).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledWith(
          "Camera controls: automatic switch dropped (auto group), the cycle camera switch, of the angle only, went out when what asked for it may already have happened",
        );
      });

      it("sends it on the same timeline without the earliest moment: the trigger is the read that saw it", async () => {
        await vi.advanceTimersByTimeAsync(100);
        await angleSwitch();

        const auto = await autoAt450({ earliestTriggerMsAgo: undefined });

        expect(auto).toHaveBeenCalledOnce();
      });

      it("sends it when the user's switch in that window changed the car: that switch is what it answers", async () => {
        await vi.advanceTimersByTimeAsync(100);
        await carSwitch();

        const auto = await autoAt450();

        expect(auto).toHaveBeenCalledOnce();
      });

      it("sends it when the angle pick went out before the earliest moment", async () => {
        vi.setSystemTime(1_000_000 - 10);
        await angleSwitch();

        const auto = await autoAt450();

        expect(auto).toHaveBeenCalledOnce();
      });

      it("drops it for an angle pick at the earliest moment itself", async () => {
        await angleSwitch();

        const auto = await autoAt450();

        expect(auto).not.toHaveBeenCalled();
      });

      it("sends it when a switch of the car followed the angle pick inside the window", async () => {
        await vi.advanceTimersByTimeAsync(50);
        await angleSwitch();
        await vi.advanceTimersByTimeAsync(50);
        await carSwitch();

        const auto = await autoAt450();

        expect(auto).toHaveBeenCalledOnce();
      });

      it("drops it when an angle pick followed a switch of the car inside the window", async () => {
        await vi.advanceTimersByTimeAsync(50);
        await carSwitch();
        await vi.advanceTimersByTimeAsync(50);
        await angleSwitch();

        const auto = await autoAt450();

        expect(auto).not.toHaveBeenCalled();
      });

      it.each([
        ["shorter than triggeredMsAgo", 100],
        ["not a finite number", Number.NaN],
      ])("takes the trigger itself as the earliest moment when it is %s", async (_label, earliestTriggerMsAgo) => {
        await vi.advanceTimersByTimeAsync(100);
        await angleSwitch();

        const auto = await autoAt450({ earliestTriggerMsAgo });

        expect(auto).toHaveBeenCalledOnce();
      });

      it("bounds nothing on a switch that gives no trigger", async () => {
        await vi.advanceTimersByTimeAsync(100);
        await angleSwitch();

        const auto = await autoAt450({ triggeredMsAgo: undefined });

        expect(auto).toHaveBeenCalledOnce();
      });
    });

    it("goes out at once on a quiet replay", async () => {
      const auto = vi.fn();

      await requestCameraSwitch(auto, automatic({ jumps: quiet() }));

      expect(auto).toHaveBeenCalledOnce();
    });
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

  it("interruptLapWalks interrupts a walk's claim and no other owner's (#1428 / #1435)", () => {
    const record = claimReplayCursor("jump-to-fastest-lap record jump");

    expect(interruptLapWalks("next-car")).toBeNull();
    expect(record.interruptedBy).toBeNull();
    expect(record.cancelledBy).toBeNull();

    for (const owner of LAP_WALK_OWNERS) {
      const walk = claimReplayCursor(owner);

      expect(interruptLapWalks("next-car")).toBe(owner);
      expect(walk.interruptedBy).toBe("next-car");
      expect(walk.cancelledBy).toBeNull();
      expect(currentReplayCursorOwner()).toBe(owner);
    }
  });

  it("interruptLapWalks leaves the captured jump speed, the pending speed and the cursor-taken listeners alone", () => {
    const listener = vi.fn();
    const at = Date.now();

    claimReplayCursor(FASTEST_LAP_WALK_OWNER);
    recordCapturedJumpSpeed({ speed: 2, slowMotion: false });
    // The pending speed: a send the telemetry has not shown yet.
    noteReplaySpeedSent({ speed: 8, slowMotion: false }, at, { rememberSpeed: true });
    const unsubscribe = onReplayCursorTaken(listener);

    interruptLapWalks("next-car");

    expect(capturedJumpSpeed()).toEqual({ speed: 2, slowMotion: false });
    expect(resolveLiveSpeed({ speed: 0, slowMotion: false }, at)).toEqual({ speed: 8, slowMotion: false });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();

    // A cancel, by contrast, takes the cursor: it clears the captured speed and supersedes the pending one for the surfaces.
    cancelLapWalks("frame-forward");

    expect(capturedJumpSpeed()).toBeNull();
    expect(resolveLiveSpeed({ speed: 0, slowMotion: false }, at)).toEqual({ speed: 0, slowMotion: false });
  });
});
