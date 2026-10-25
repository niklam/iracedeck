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
  claimReplayCursor,
  currentReplayCursorOwner,
  onReplayCursorTaken,
  pendingReplayJumpSpeed,
  recordReplayJumpSpeed,
  type ReplayCursorClaim,
} from "./replay-cursor.js";
import { _configureReplayEngine } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { noteReplaySpeedSent, resolveLiveSpeed } from "./replay-speed-state.js";
import { REPLAY_JUMP_MAX_WAIT_MS } from "./replay-timing.js";

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

  it("sends at once outside a replay, whatever the jump reads and the plugin's holds say", async () => {
    resetEngine({ logger: engineRootLogger, now: () => Date.now(), inReplay: () => false });

    const send = vi.fn();
    const jump = jumpUnderWay();

    const request = requestCameraSwitch(send, options({ jumps: jump.jumps }));

    // A jump left standing by leaving the replay (#1428 / #1435 second read)
    // must not park a live press, which the replay's absence would then drop.
    expect(send).toHaveBeenCalledOnce();
    await request;

    expect(jump.jumps.waitToSettle).not.toHaveBeenCalled();
    expect(isCameraSwitchWaiting()).toBe(false);
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

  it("interruptLapWalks leaves the pending jump speed, the dial's pending speed and the cursor-taken listeners alone", () => {
    const listener = vi.fn();
    const at = Date.now();

    claimReplayCursor(FASTEST_LAP_WALK_OWNER);
    recordReplayJumpSpeed({ speed: 2, slowMotion: false, appliedAt: null });
    // The dial's pending speed: a send the telemetry has not shown yet.
    noteReplaySpeedSent({ speed: 8, slowMotion: false }, at, { rememberSpeed: true });
    const unsubscribe = onReplayCursorTaken(listener);

    interruptLapWalks("next-car");

    expect(pendingReplayJumpSpeed()).toEqual({ speed: 2, slowMotion: false, appliedAt: null });
    expect(resolveLiveSpeed({ speed: 0, slowMotion: false }, at)).toEqual({ speed: 8, slowMotion: false });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();

    // A cancel, by contrast, takes the cursor and clears both.
    cancelLapWalks("frame-forward");

    expect(pendingReplayJumpSpeed()).toBeNull();
    expect(resolveLiveSpeed({ speed: 0, slowMotion: false }, at)).toEqual({ speed: 0, slowMotion: false });
  });
});
