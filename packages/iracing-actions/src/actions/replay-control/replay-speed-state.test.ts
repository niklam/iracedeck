import { beforeEach, describe, expect, it } from "vitest";

import type { ReplaySpeed } from "./replay-control-dial-mode.js";
import {
  _resetReplaySpeedState,
  clearDialPendingSpeed,
  DIAL_SPEED_HOLD_MS,
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

    it("should resume 4x after Play, a turn to 4x and Pause inside one telemetry frame", () => {
      noteDialSpeedSent(speed(1), T0);
      noteDialSpeedSent(speed(4), T0 + 3);
      noteDialSpeedSent(PAUSED, T0 + 6);

      expect(rememberedSpeed()).toEqual(speed(4));
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

    it("should survive a stale tick from before a pause the dial just sent", () => {
      noteTelemetrySpeed(speed(2), T0);
      noteDialSpeedSent(PAUSED, T0 + 10);
      reverseRememberedSpeed();
      noteTelemetrySpeed(speed(2), T0 + 16);

      expect(rememberedSpeed()).toEqual(speed(-2));
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

    it("should let telemetry feed the remembered speed again", () => {
      noteDialSpeedSent(PAUSED, T0);
      noteTelemetrySpeed(speed(8), T0 + 10);
      expect(rememberedSpeed()).toEqual(speed(1));

      clearDialPendingSpeed();
      noteTelemetrySpeed(speed(8), T0 + 20);

      expect(rememberedSpeed()).toEqual(speed(8));
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
});
