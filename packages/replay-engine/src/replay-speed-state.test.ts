import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, cancelReplayCursorOwner, claimReplayCursor } from "./replay-cursor.js";
import type { ReplaySpeed } from "./replay-jump-speed.js";
import {
  _resetReplaySpeedState,
  clearDialPendingSpeed,
  DIAL_SPEED_HOLD_MS,
  keepDialPendingSpeed,
  noteDialSpeedSent,
  noteTelemetrySpeed,
  rememberedSpeed,
  resolveLiveSpeed,
  reverseRememberedSpeed,
} from "./replay-speed-state.js";

function speed(value: number, slowMotion = false): ReplaySpeed {
  return { speed: value, slowMotion };
}

const PAUSED = speed(0);

/** An arbitrary clock reading; every test passes its own time in. */
const T0 = 10_000;

describe("replay-speed-state", () => {
  beforeEach(() => {
    _resetReplaySpeedState();
  });

  describe("the live speed", () => {
    it("should be the telemetry speed when nothing is pending", () => {
      expect(resolveLiveSpeed(speed(4), T0)).toEqual(speed(4));
      expect(resolveLiveSpeed(speed(-4, true), T0)).toEqual(speed(-4, true));
    });

    it("should read as paused with no telemetry speed and nothing pending", () => {
      expect(resolveLiveSpeed(null, T0)).toEqual(PAUSED);
    });

    it("should read as the speed a dial sent while telemetry still carries the old one", () => {
      noteDialSpeedSent(speed(2), T0);

      expect(resolveLiveSpeed(speed(1), T0 + 20)).toEqual(speed(2));
      expect(resolveLiveSpeed(speed(1), T0 + DIAL_SPEED_HOLD_MS - 1)).toEqual(speed(2));
    });

    it("should let two sends inside one telemetry frame build on each other", () => {
      noteDialSpeedSent(speed(2), T0);
      expect(resolveLiveSpeed(speed(1), T0 + 5)).toEqual(speed(2));

      noteDialSpeedSent(speed(4), T0 + 5);
      expect(resolveLiveSpeed(speed(1), T0 + 10)).toEqual(speed(4));
      // The first send's speed arriving late is not the newer target either.
      expect(resolveLiveSpeed(speed(2), T0 + 30)).toEqual(speed(4));
    });

    it("should return to telemetry once the hold has run out", () => {
      noteDialSpeedSent(speed(2), T0);

      expect(resolveLiveSpeed(speed(1), T0 + DIAL_SPEED_HOLD_MS)).toEqual(speed(1));
    });

    it("should drop the pending speed for good once telemetry has reported it", () => {
      noteDialSpeedSent(speed(2), T0);

      expect(resolveLiveSpeed(speed(2), T0 + 50)).toEqual(speed(2));
      // A key or iRacing's own bar changes the speed inside what was the hold.
      expect(resolveLiveSpeed(speed(8), T0 + 60)).toEqual(speed(8));
    });

    it("should hold a pause the dial sent, so the next read is 0 whatever the tick carries", () => {
      noteDialSpeedSent(PAUSED, T0);

      expect(resolveLiveSpeed(speed(4), T0 + 16)).toEqual(PAUSED);
      expect(resolveLiveSpeed(null, T0 + 16)).toEqual(PAUSED);
      expect(resolveLiveSpeed(speed(4), T0 + DIAL_SPEED_HOLD_MS)).toEqual(speed(4));
    });

    it("should hand out a copy, never the stored speed", () => {
      noteDialSpeedSent(speed(2), T0);
      resolveLiveSpeed(speed(1), T0 + 1).speed = 99;

      expect(resolveLiveSpeed(speed(1), T0 + 2)).toEqual(speed(2));
    });
  });

  describe("the remembered speed", () => {
    it("should be 1x before any sample", () => {
      expect(rememberedSpeed()).toEqual(speed(1));
    });

    it("should follow non-zero telemetry samples, whoever set the speed", () => {
      noteTelemetrySpeed(speed(4), T0);
      expect(rememberedSpeed()).toEqual(speed(4));

      noteTelemetrySpeed(speed(-2, true), T0 + 16);
      expect(rememberedSpeed()).toEqual(speed(-2, true));
    });

    it("should never be overwritten by a 0", () => {
      noteTelemetrySpeed(speed(4), T0);
      noteTelemetrySpeed(PAUSED, T0 + 16);
      noteTelemetrySpeed(PAUSED, T0 + 32);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should take a non-zero dial send at once, before telemetry reports it", () => {
      noteDialSpeedSent(speed(4), T0);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should keep the speed that was playing through a pause the dial sent", () => {
      noteTelemetrySpeed(speed(8), T0);
      noteDialSpeedSent(PAUSED, T0 + 16);

      expect(rememberedSpeed()).toEqual(speed(8));
    });

    it("should resume 4x after Play, a turn to 4x that telemetry reports, and Pause", () => {
      noteDialSpeedSent(speed(1), T0);
      noteTelemetrySpeed(speed(1), T0 + 30);
      noteDialSpeedSent(speed(4), T0 + 100);
      noteTelemetrySpeed(speed(4), T0 + 130);
      noteDialSpeedSent(PAUSED, T0 + 200);
      noteTelemetrySpeed(PAUSED, T0 + 230);

      // Long after every hold: the 4x was seen playing, so it stays.
      resolveLiveSpeed(PAUSED, T0 + 5_000);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should resume 4x at once after Play, a turn to 4x and Pause inside one telemetry frame", () => {
      noteDialSpeedSent(speed(1), T0);
      noteDialSpeedSent(speed(4), T0 + 3);
      noteDialSpeedSent(PAUSED, T0 + 6);

      // Nothing has reported 4x yet: it is the resume speed provisionally.
      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should let a non-zero sample behind a pending pause through: that speed did play", () => {
      noteDialSpeedSent(PAUSED, T0);

      // A key set 8x just before the dial paused; the tick carrying it arrives late.
      noteTelemetrySpeed(speed(8), T0 + 10);

      expect(rememberedSpeed()).toEqual(speed(8));
    });

    it("should ignore a tick that still carries the speed from before a pending send", () => {
      noteTelemetrySpeed(speed(1), T0);
      noteDialSpeedSent(speed(4), T0 + 10);
      noteTelemetrySpeed(speed(1), T0 + 16);
      noteTelemetrySpeed(speed(1), T0 + 32);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should follow telemetry again once it has reported the send", () => {
      noteDialSpeedSent(speed(4), T0);
      noteTelemetrySpeed(speed(4), T0 + 50);
      noteTelemetrySpeed(speed(2), T0 + 66);

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should follow telemetry again once the hold has run out", () => {
      noteDialSpeedSent(speed(4), T0);
      noteTelemetrySpeed(speed(1), T0 + DIAL_SPEED_HOLD_MS);

      expect(rememberedSpeed()).toEqual(speed(1));
    });

    it("should hand out a copy, never the stored speed", () => {
      rememberedSpeed().speed = 99;

      expect(rememberedSpeed()).toEqual(speed(1));
    });
  });

  describe("reverseRememberedSpeed", () => {
    it("should flip the direction and keep the magnitude and the slow-motion flag", () => {
      noteTelemetrySpeed(speed(4, true), T0);

      expect(reverseRememberedSpeed()).toEqual(speed(-4, true));
      expect(rememberedSpeed()).toEqual(speed(-4, true));
      expect(reverseRememberedSpeed()).toEqual(speed(4, true));
    });

    it("should flip the 1x default before any sample", () => {
      expect(reverseRememberedSpeed()).toEqual(speed(-1));
    });

    it("should survive the ticks that still carry the paused replay's 0", () => {
      noteTelemetrySpeed(speed(2), T0);
      reverseRememberedSpeed();
      noteTelemetrySpeed(PAUSED, T0 + 16);

      expect(rememberedSpeed()).toEqual(speed(-2));
    });

    it("should survive the hold of a pause the dial sent, once telemetry reads paused", () => {
      noteTelemetrySpeed(speed(2), T0);
      noteDialSpeedSent(PAUSED, T0 + 10);
      noteTelemetrySpeed(PAUSED, T0 + 16);
      reverseRememberedSpeed();
      noteTelemetrySpeed(PAUSED, T0 + 32);
      resolveLiveSpeed(PAUSED, T0 + 10 + DIAL_SPEED_HOLD_MS);

      expect(rememberedSpeed()).toEqual(speed(-2));
    });
  });

  describe("a send iRacing did not act on", () => {
    /** Past the hold of a send made at `sentAt`. */
    const lapsedAfter = (sentAt: number) => sentAt + DIAL_SPEED_HOLD_MS;

    beforeEach(() => {
      // The replay really played at 2x.
      noteTelemetrySpeed(speed(2), T0 - 100);
    });

    it("should give the remembered speed back when the hold runs out unreported", () => {
      noteDialSpeedSent(speed(4), T0);
      expect(rememberedSpeed()).toEqual(speed(4));

      // No tick ever carried 4x: the replay sits paused at the end of the recording.
      expect(resolveLiveSpeed(PAUSED, lapsedAfter(T0))).toEqual(PAUSED);

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should go back to the original speed after two ignored sends in a row", () => {
      noteDialSpeedSent(speed(4), T0);
      noteDialSpeedSent(speed(8), T0 + 100);
      expect(rememberedSpeed()).toEqual(speed(8));

      resolveLiveSpeed(PAUSED, lapsedAfter(T0 + 100));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should go back to the original speed after an ignored send, a pause and another send", () => {
      noteDialSpeedSent(speed(4), T0);
      noteDialSpeedSent(PAUSED, T0 + 50);
      noteDialSpeedSent(speed(8), T0 + 100);

      resolveLiveSpeed(PAUSED, lapsedAfter(T0 + 100));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should carry the original speed through a dial's own cursor take", () => {
      noteDialSpeedSent(speed(4), T0);
      keepDialPendingSpeed(() => cancelReplayCursorOwner("dial-speed"));
      noteDialSpeedSent(speed(8), T0 + 100);

      resolveLiveSpeed(PAUSED, lapsedAfter(T0 + 100));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should notice a lapse nothing read, at the next send", () => {
      noteDialSpeedSent(speed(4), T0);
      // Nothing reads the live speed until the next send, well past the hold.
      noteDialSpeedSent(speed(8), lapsedAfter(T0) + 10);
      expect(rememberedSpeed()).toEqual(speed(8));

      resolveLiveSpeed(PAUSED, lapsedAfter(lapsedAfter(T0) + 10));

      // Back to 2x, the speed the first lapse restored, never to the ignored 4x.
      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should notice a lapse on the next telemetry sample too", () => {
      noteDialSpeedSent(speed(4), T0);

      noteTelemetrySpeed(PAUSED, lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should keep the new speed when telemetry reported the send", () => {
      noteDialSpeedSent(speed(4), T0);
      expect(resolveLiveSpeed(speed(4), T0 + 50)).toEqual(speed(4));

      resolveLiveSpeed(speed(4), lapsedAfter(T0));
      resolveLiveSpeed(PAUSED, lapsedAfter(T0) + 1_000);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should keep a reported speed when a later send is the ignored one", () => {
      noteDialSpeedSent(speed(4), T0);
      noteTelemetrySpeed(speed(4), T0 + 50);
      noteDialSpeedSent(speed(8), T0 + 100);

      resolveLiveSpeed(speed(4), lapsedAfter(T0 + 100));

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should leave the remembered speed alone when the ignored send was a pause", () => {
      noteDialSpeedSent(PAUSED, T0);

      resolveLiveSpeed(speed(2), lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should not undo a Reverse made while the hold stood", () => {
      noteDialSpeedSent(speed(4), T0);
      reverseRememberedSpeed();

      resolveLiveSpeed(PAUSED, lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(-4));
    });

    it("should go back to the original speed when a 0x send follows the ignored one inside the hold", () => {
      noteDialSpeedSent(speed(4), T0);
      // A pause, or a turn back to 0x: the paused replay reports it at once.
      noteDialSpeedSent(PAUSED, T0 + 100);
      expect(resolveLiveSpeed(PAUSED, T0 + 110)).toEqual(PAUSED);
      expect(rememberedSpeed()).toEqual(speed(4));

      resolveLiveSpeed(PAUSED, lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should go back to the original speed when the 0x send's own hold is the one that runs out", () => {
      noteDialSpeedSent(speed(4), T0);
      noteDialSpeedSent(PAUSED, T0 + 100);

      // Nothing is read until both holds are long over, and no sample ever came.
      resolveLiveSpeed(null, T0 + 5_000);

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should go back to the original speed when another action takes the cursor inside the hold", () => {
      noteDialSpeedSent(speed(4), T0);
      cancelReplayCursorOwner("replay-transport-play");
      // The overlay is gone at once; whether 4x ever played is still open.
      expect(resolveLiveSpeed(PAUSED, T0 + 10)).toEqual(PAUSED);
      expect(rememberedSpeed()).toEqual(speed(4));

      resolveLiveSpeed(PAUSED, lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should go back to the original speed when a walk claims the cursor inside the hold", () => {
      noteDialSpeedSent(speed(4), T0);
      claimReplayCursor("jump-to-fastest-lap");

      noteTelemetrySpeed(PAUSED, lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should keep a send that took when a 0x send follows it", () => {
      noteDialSpeedSent(speed(4), T0);
      noteTelemetrySpeed(speed(4), T0 + 50);
      noteDialSpeedSent(PAUSED, T0 + 100);

      resolveLiveSpeed(PAUSED, T0 + 5_000);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should keep a send that took when the 0x send comes before telemetry reports it", () => {
      noteDialSpeedSent(speed(4), T0);
      noteDialSpeedSent(PAUSED, T0 + 20);
      // The 4x frame is reported after the pause was sent, then the pause lands.
      noteTelemetrySpeed(speed(4), T0 + 40);
      noteTelemetrySpeed(PAUSED, T0 + 60);

      resolveLiveSpeed(PAUSED, T0 + 5_000);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should keep a send that took when another action takes the cursor after it", () => {
      noteDialSpeedSent(speed(4), T0);
      cancelReplayCursorOwner("next-lap");
      noteTelemetrySpeed(speed(4), T0 + 50);

      resolveLiveSpeed(speed(4), T0 + 5_000);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should keep a send that took when the cursor take comes after telemetry reported it", () => {
      noteDialSpeedSent(speed(4), T0);
      noteTelemetrySpeed(speed(4), T0 + 50);
      cancelReplayCursorOwner("next-lap");

      resolveLiveSpeed(speed(4), T0 + 5_000);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should not undo a Reverse made while paused between an ignored send and the lapse, cursor take or not", () => {
      noteDialSpeedSent(speed(4), T0);
      noteDialSpeedSent(PAUSED, T0 + 50);
      cancelReplayCursorOwner("next-lap");
      reverseRememberedSpeed();

      resolveLiveSpeed(PAUSED, lapsedAfter(T0));

      expect(rememberedSpeed()).toEqual(speed(-4));
    });

    it("should hold samples from before an unconfirmed send back until it is settled, overlay or not", () => {
      noteDialSpeedSent(speed(4), T0);
      cancelReplayCursorOwner("next-lap");

      // Ticks still carrying the 2x from before the send must not win over it.
      noteTelemetrySpeed(speed(2), T0 + 16);
      expect(rememberedSpeed()).toEqual(speed(4));

      noteTelemetrySpeed(speed(4), T0 + 48);
      noteTelemetrySpeed(speed(8), T0 + 64);
      expect(rememberedSpeed()).toEqual(speed(8));
    });
  });

  describe("clearDialPendingSpeed", () => {
    it("should let the live speed follow telemetry at once", () => {
      noteDialSpeedSent(PAUSED, T0);
      expect(resolveLiveSpeed(speed(4), T0 + 10)).toEqual(PAUSED);

      clearDialPendingSpeed();

      // A key's Play landed: the tick's speed is the live one, inside what was the hold.
      expect(resolveLiveSpeed(speed(1), T0 + 20)).toEqual(speed(1));
      expect(resolveLiveSpeed(speed(4), T0 + 30)).toEqual(speed(4));
    });

    it("should read as paused with no telemetry speed once the pending one is gone", () => {
      noteDialSpeedSent(speed(4), T0);

      clearDialPendingSpeed();

      expect(resolveLiveSpeed(null, T0 + 10)).toEqual(PAUSED);
    });

    it("should leave an unconfirmed speed provisional: samples from before the send still wait", () => {
      noteTelemetrySpeed(speed(2), T0 - 100);
      noteDialSpeedSent(speed(4), T0);

      clearDialPendingSpeed();
      noteTelemetrySpeed(speed(2), T0 + 20);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should leave the remembered speed alone", () => {
      noteDialSpeedSent(speed(4), T0);

      clearDialPendingSpeed();

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should do nothing when no speed is pending", () => {
      noteTelemetrySpeed(speed(2), T0);

      clearDialPendingSpeed();

      expect(resolveLiveSpeed(speed(2), T0 + 10)).toEqual(speed(2));
      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("should not stop a later dial send from holding again", () => {
      noteDialSpeedSent(speed(2), T0);
      clearDialPendingSpeed();
      noteDialSpeedSent(speed(4), T0 + 10);

      expect(resolveLiveSpeed(speed(1), T0 + 20)).toEqual(speed(4));
    });
  });

  describe("taking the replay cursor", () => {
    beforeEach(() => {
      _resetReplayCursor();
    });

    it("should drop the pending speed on any one-shot command, whichever action sends it", () => {
      noteDialSpeedSent(PAUSED, T0);
      expect(resolveLiveSpeed(speed(4), T0 + 10)).toEqual(PAUSED);

      // Replay Transport's Play, a key's Set Speed, a marker jump: each cancels first.
      cancelReplayCursorOwner("replay-transport-play");

      expect(resolveLiveSpeed(speed(4), T0 + 20)).toEqual(speed(4));
    });

    it("should drop the pending speed when a walk claims the cursor", () => {
      noteDialSpeedSent(speed(8), T0);

      claimReplayCursor("jump-to-fastest-lap");

      expect(resolveLiveSpeed(speed(1), T0 + 10)).toEqual(speed(1));
    });

    it("should leave the remembered speed alone", () => {
      noteDialSpeedSent(speed(4), T0);

      cancelReplayCursorOwner("play-pause");

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("should stay wired through a cursor reset", () => {
      _resetReplayCursor();
      noteDialSpeedSent(PAUSED, T0);

      cancelReplayCursorOwner("play-pause");

      expect(resolveLiveSpeed(speed(4), T0 + 10)).toEqual(speed(4));
    });

    it("should keep the pending speed across a dial's own take", () => {
      noteDialSpeedSent(PAUSED, T0);
      const onCancelled = vi.fn();
      claimReplayCursor("jump-to-fastest-lap", onCancelled);
      // The claim dropped it; the dial pauses again and then takes the cursor for its step.
      noteDialSpeedSent(PAUSED, T0 + 5);

      const cancelled = keepDialPendingSpeed(() => cancelReplayCursorOwner("dial-frame-jog"));

      // The take itself still happened.
      expect(cancelled).toBe("jump-to-fastest-lap");
      expect(onCancelled).toHaveBeenCalledWith("dial-frame-jog");
      expect(resolveLiveSpeed(speed(4), T0 + 10)).toEqual(PAUSED);
    });

    it("should put the pending speed back even when the take throws", () => {
      noteDialSpeedSent(speed(2), T0);

      expect(() =>
        keepDialPendingSpeed(() => {
          cancelReplayCursorOwner("dial-speed");

          throw new Error("no connection");
        }),
      ).toThrow("no connection");

      expect(resolveLiveSpeed(speed(1), T0 + 10)).toEqual(speed(2));
    });

    it("should keep nothing when nothing was pending", () => {
      keepDialPendingSpeed(() => cancelReplayCursorOwner("dial-speed"));

      expect(resolveLiveSpeed(speed(1), T0)).toEqual(speed(1));
    });
  });
});
