import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import {
  getTireChangeGranularity,
  hasPitLimiter,
  hasVisor,
  hasWipers,
  initialReplayState,
  isPenaltyFlagActive,
  isPostRace,
  isPreGreen,
  nextReplayState,
  REPLAY_EXIT_GRACE_MS,
  replayLeftForLive,
  type ReplayState,
  replayStateAt,
  resolveReplayFrame,
} from "./telemetry-features.js";

/** Build a minimal TelemetryData mock from a partial set of fields. */
function telemetry(fields: Partial<TelemetryData>): TelemetryData {
  return fields as TelemetryData;
}

/** A tick that reads as a replay at `frame`. */
const replayTick = (frame: number): TelemetryData =>
  telemetry({ IsReplayPlaying: true, ReplayFrameNum: frame, ReplayFrameNumEnd: 100 });

/** A tick that reads as live, the recording `end` frames long. */
const liveTick = (end: number): TelemetryData =>
  telemetry({ IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: end });

const LIVE_SESSION = { WeekendInfo: { SimMode: "full" } };
const SAVED_REPLAY = { WeekendInfo: { SimMode: "replay" } };

/** Steps `state` through `ticks`, each `[telemetry, nowMs]`, in a live session unless `sessionInfo` says otherwise. */
function run(ticks: readonly [TelemetryData, number][], sessionInfo: unknown = LIVE_SESSION): ReplayState {
  return ticks.reduce((state, [tick, nowMs]) => nextReplayState(state, tick, sessionInfo, nowMs), initialReplayState());
}

describe("telemetry-features", () => {
  describe("hasPitLimiter", () => {
    it("returns true when dcPitSpeedLimiterToggle is present", () => {
      expect(hasPitLimiter(telemetry({ dcPitSpeedLimiterToggle: false }))).toBe(true);
      expect(hasPitLimiter(telemetry({ dcPitSpeedLimiterToggle: true }))).toBe(true);
    });

    it("returns false when the field is absent", () => {
      expect(hasPitLimiter(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasPitLimiter(null)).toBe(false);
    });
  });

  describe("hasVisor", () => {
    it("returns true when dcTearOffVisor is present", () => {
      expect(hasVisor(telemetry({ dcTearOffVisor: false }))).toBe(true);
    });

    it("returns false when the field is absent", () => {
      expect(hasVisor(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasVisor(null)).toBe(false);
    });
  });

  describe("hasWipers", () => {
    it("returns true when dcToggleWindshieldWipers is present", () => {
      expect(hasWipers(telemetry({ dcToggleWindshieldWipers: false }))).toBe(true);
    });

    it("returns true when dcTriggerWindshieldWipers is present", () => {
      expect(hasWipers(telemetry({ dcTriggerWindshieldWipers: false }))).toBe(true);
    });

    it("returns true when both wiper fields are present", () => {
      expect(hasWipers(telemetry({ dcToggleWindshieldWipers: false, dcTriggerWindshieldWipers: false }))).toBe(true);
    });

    it("returns false when neither wiper field is present", () => {
      expect(hasWipers(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasWipers(null)).toBe(false);
    });
  });

  describe("getTireChangeGranularity", () => {
    it("returns corner when all four corner fields are present", () => {
      expect(
        getTireChangeGranularity(
          telemetry({ dpLFTireChange: 0, dpRFTireChange: 0, dpLRTireChange: 0, dpRRTireChange: 0 }),
        ),
      ).toBe("corner");
    });

    it("returns corner when any single corner field is present", () => {
      expect(getTireChangeGranularity(telemetry({ dpRRTireChange: 0 }))).toBe("corner");
    });

    it("returns side when only the side fields are present", () => {
      expect(getTireChangeGranularity(telemetry({ dpLTireChange: 0, dpRTireChange: 0 }))).toBe("side");
    });

    it("returns side when only one side field is present", () => {
      expect(getTireChangeGranularity(telemetry({ dpRTireChange: 0 }))).toBe("side");
    });

    it("returns all when only dpTireChange is present", () => {
      expect(getTireChangeGranularity(telemetry({ dpTireChange: 0 }))).toBe("all");
    });

    it("resolves an unexpected corner + all combination to the finer level", () => {
      expect(getTireChangeGranularity(telemetry({ dpLFTireChange: 0, dpTireChange: 0 }))).toBe("corner");
    });

    it("resolves an unexpected side + all combination to the finer level", () => {
      expect(getTireChangeGranularity(telemetry({ dpLTireChange: 0, dpTireChange: 0 }))).toBe("side");
    });

    it("reads presence, not value", () => {
      expect(getTireChangeGranularity(telemetry({ dpTireChange: 1 }))).toBe("all");
    });

    it("returns null when no field is present", () => {
      expect(getTireChangeGranularity(telemetry({}))).toBeNull();
    });

    it("returns null for null or undefined telemetry", () => {
      expect(getTireChangeGranularity(null)).toBeNull();
      expect(getTireChangeGranularity(undefined)).toBeNull();
    });
  });

  describe("isPreGreen", () => {
    it("returns true for the pre-racing states (Invalid / GetInCar / Warmup / ParadeLaps)", () => {
      expect(isPreGreen(telemetry({ SessionState: SessionState.Invalid }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.GetInCar }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.Warmup }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.ParadeLaps }))).toBe(true);
    });

    it("returns false once racing and for the post-racing states", () => {
      expect(isPreGreen(telemetry({ SessionState: SessionState.Racing }))).toBe(false);
      expect(isPreGreen(telemetry({ SessionState: SessionState.Checkered }))).toBe(false);
      expect(isPreGreen(telemetry({ SessionState: SessionState.CoolDown }))).toBe(false);
    });

    it("returns false when SessionState is absent (back-compat default)", () => {
      expect(isPreGreen(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPreGreen(null)).toBe(false);
      expect(isPreGreen(undefined)).toBe(false);
    });
  });

  describe("isPenaltyFlagActive", () => {
    it("returns true when the Black bit is set", () => {
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Black }))).toBe(true);
    });

    it("returns true when the Disqualify bit is set (alone or with Black)", () => {
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Disqualify }))).toBe(true);
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Black | Flags.Disqualify }))).toBe(true);
    });

    it("returns true when a penalty bit rides alongside unrelated bits (the captured #846 escalation)", () => {
      // SessionFlags 0x10050000 — StartHidden | Servicible | Black.
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: 268763136 }))).toBe(true);
    });

    it("returns false for non-penalty flags (Furled is a warning, not a penalty)", () => {
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Furled }))).toBe(false);
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Green | Flags.Yellow }))).toBe(false);
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: 0 }))).toBe(false);
    });

    it("returns false when SessionFlags is absent (don't punish missing data)", () => {
      expect(isPenaltyFlagActive(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPenaltyFlagActive(null)).toBe(false);
      expect(isPenaltyFlagActive(undefined)).toBe(false);
    });
  });

  describe("isPostRace", () => {
    it("returns true for the post-racing states (Checkered / CoolDown)", () => {
      expect(isPostRace(telemetry({ SessionState: SessionState.Checkered }))).toBe(true);
      expect(isPostRace(telemetry({ SessionState: SessionState.CoolDown }))).toBe(true);
    });

    it("returns false for the pre-racing and racing states", () => {
      expect(isPostRace(telemetry({ SessionState: SessionState.Invalid }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.GetInCar }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.Warmup }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.ParadeLaps }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.Racing }))).toBe(false);
    });

    it("returns false when SessionState is absent (back-compat default)", () => {
      expect(isPostRace(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPostRace(null)).toBe(false);
      expect(isPostRace(undefined)).toBe(false);
    });
  });

  describe("resolveReplayFrame (#1162)", () => {
    it("reads ReplayFrameNumEnd on a live tick — ReplayFrameNum is a constant 0 while driving", () => {
      expect(
        resolveReplayFrame(
          telemetry({ IsReplayPlaying: false, IsOnTrack: true, ReplayFrameNum: 0, ReplayFrameNumEnd: 30821 }),
        ),
      ).toBe(30821);
    });

    it("reads ReplayFrameNum in a replay — the absolute position over the recording", () => {
      expect(
        resolveReplayFrame(telemetry({ IsReplayPlaying: true, ReplayFrameNum: 55657, ReplayFrameNumEnd: 26000 })),
      ).toBe(55657);
    });

    it("still reads ReplayFrameNum in a paused replay (speed 0, IsReplayPlaying true)", () => {
      expect(
        resolveReplayFrame(
          telemetry({ IsReplayPlaying: true, ReplayPlaySpeed: 0, ReplayFrameNum: 44373, ReplayFrameNumEnd: 100 }),
        ),
      ).toBe(44373);
    });

    it("treats a missing IsReplayPlaying as live", () => {
      expect(resolveReplayFrame(telemetry({ ReplayFrameNum: 7, ReplayFrameNumEnd: 900 }))).toBe(900);
    });

    it("returns null when the field the mode needs is missing", () => {
      expect(resolveReplayFrame(telemetry({ IsReplayPlaying: false, ReplayFrameNum: 0 }))).toBeNull();
      expect(resolveReplayFrame(telemetry({ IsReplayPlaying: true, ReplayFrameNumEnd: 100 }))).toBeNull();
    });

    it("returns null when the field is not a finite number", () => {
      expect(resolveReplayFrame(telemetry({ IsReplayPlaying: true, ReplayFrameNum: Number.NaN }))).toBeNull();
      expect(resolveReplayFrame(telemetry({ ReplayFrameNumEnd: "30821" as unknown as number }))).toBeNull();
    });

    it("returns null for null/undefined telemetry", () => {
      expect(resolveReplayFrame(null)).toBeNull();
      expect(resolveReplayFrame(undefined)).toBeNull();
    });
  });

  describe("the debounced replay state (#1324)", () => {
    it("holds the replay for 1 s after the last replay tick — #1230's margin over the ~300 ms blip", () => {
      expect(REPLAY_EXIT_GRACE_MS).toBe(1_000);
    });

    it("starts live with nothing sighted", () => {
      expect(initialReplayState()).toMatchObject({ inReplay: false, frame: null, replaySeenAt: null });
    });

    describe("nextReplayState", () => {
      it("enters a replay at once, with the tick's ReplayFrameNum", () => {
        const state = run([[replayTick(500), 0]]);

        expect(state.inReplay).toBe(true);
        expect(state.frame).toBe(500);
      });

      it("stays in the replay while the flag has read false for 999 ms, and leaves at 1 000 ms", () => {
        const ticks: [TelemetryData, number][] = [[replayTick(500), 0]];

        for (let t = 10; t < 999; t += 10) ticks.push([liveTick(900), t]);

        const at999 = nextReplayState(run(ticks), liveTick(900), LIVE_SESSION, 999);
        const at1000 = nextReplayState(at999, liveTick(900), LIVE_SESSION, 1_000);

        expect(at999.inReplay).toBe(true);
        expect(at1000.inReplay).toBe(false);
      });

      it("holds the last replay frame through the grace and reads ReplayFrameNumEnd once live", () => {
        const inGrace = run([
          [replayTick(500), 0],
          [liveTick(900), 300],
        ]);
        const live = nextReplayState(inGrace, liveTick(901), LIVE_SESSION, 1_000);

        expect(inGrace.frame).toBe(500);
        expect(live).toMatchObject({ inReplay: false, frame: 901 });
      });

      it("runs the grace from the LAST replay tick, so a seek blip inside a longer replay never leaves", () => {
        const state = run([
          [replayTick(500), 0],
          [replayTick(560), 1_000],
          [liveTick(900), 1_999],
        ]);

        expect(state).toMatchObject({ inReplay: true, frame: 560 });
      });

      it("is always in a replay in a saved replay, whatever the flag reads", () => {
        const state = run([[liveTick(900), 5_000]], SAVED_REPLAY);

        expect(state.inReplay).toBe(true);
      });

      it("in a saved replay reads ReplayFrameNum past the grace, and the held frame inside it", () => {
        // Past the grace: no sighting at all, the tick's own ReplayFrameNum.
        // This branch is unverified against the sim (see replayStateAt).
        const pastGrace = run(
          [[telemetry({ IsReplayPlaying: false, ReplayFrameNum: 777, ReplayFrameNumEnd: 100 }), 5_000]],
          SAVED_REPLAY,
        );
        const inGrace = run(
          [
            [replayTick(500), 0],
            [telemetry({ IsReplayPlaying: false, ReplayFrameNum: 777, ReplayFrameNumEnd: 100 }), 300],
          ],
          SAVED_REPLAY,
        );

        expect(pastGrace.frame).toBe(777);
        expect(inGrace.frame).toBe(500);
      });

      it.each([null, undefined])(
        "keeps the saved-replay answer through a %s session-info read (an empty or unparsable YAML read), so one such tick cannot drop a paused saved replay",
        (missing) => {
          const saved = run([[liveTick(900), 5_000]], SAVED_REPLAY);
          const held = nextReplayState(saved, liveTick(900), missing, 5_010);
          // Live stays live too: a missing read never invents a saved replay.
          const live = nextReplayState(run([[liveTick(900), 0]]), liveTick(900), missing, 10);

          expect(held).toMatchObject({ inReplay: true, replayOnlySession: true });
          expect(live).toMatchObject({ inReplay: false, replayOnlySession: false });
        },
      );

      it("takes a session-info read without the field as live, and a reset clears the saved-replay answer", () => {
        const saved = run([[liveTick(900), 5_000]], SAVED_REPLAY);
        const noField = nextReplayState(saved, liveTick(900), { WeekendInfo: {} }, 5_010);
        const reset = nextReplayState(initialReplayState(), liveTick(900), null, 5_020);

        expect(noField).toMatchObject({ inReplay: false, replayOnlySession: false });
        expect(reset).toMatchObject({ inReplay: false, replayOnlySession: false });
      });

      it("reads a missing or non-finite frame as null without changing the answer", () => {
        const replay = run([[telemetry({ IsReplayPlaying: true, ReplayFrameNum: Number.NaN }), 0]]);
        const live = run([[telemetry({ IsReplayPlaying: false }), 0]]);

        expect(replay).toMatchObject({ inReplay: true, frame: null });
        expect(live).toMatchObject({ inReplay: false, frame: null });
      });

      it("drops the sighting once the replay is left, so a later entry starts a fresh grace", () => {
        const left = run([
          [replayTick(500), 0],
          [liveTick(900), 1_000],
        ]);
        const reentered = nextReplayState(left, replayTick(600), LIVE_SESSION, 1_010);

        expect(left.replaySeenAt).toBeNull();
        expect(reentered).toMatchObject({ inReplay: true, frame: 600, replaySeenAt: 1_010 });
      });
    });

    describe("replayStateAt", () => {
      it("sees the grace expire between ticks, at the caller's time", () => {
        const state = run([
          [replayTick(500), 0],
          [liveTick(900), 300],
        ]);

        expect(replayStateAt(state, 999)).toMatchObject({ inReplay: true, frame: 500 });
        expect(replayStateAt(state, 1_000)).toMatchObject({ inReplay: false, frame: 900 });
      });

      it("keeps a replay tick in the replay however late it is read", () => {
        const state = run([[replayTick(500), 0]]);

        expect(replayStateAt(state, 60_000)).toMatchObject({ inReplay: true, frame: 500 });
      });

      it("keeps a saved replay in the replay however late it is read", () => {
        const state = run([[liveTick(900), 0]], SAVED_REPLAY);

        expect(replayStateAt(state, 60_000).inReplay).toBe(true);
      });

      it("returns the same object when the answer has not changed", () => {
        const state = run([
          [replayTick(500), 0],
          [liveTick(900), 300],
        ]);

        expect(replayStateAt(state, 500)).toBe(state);
        expect(replayStateAt(state, 1_000)).not.toBe(state);
      });
    });

    describe("replayLeftForLive", () => {
      it("ends the grace at once outside a saved replay: the next false tick is the car", () => {
        const left = replayLeftForLive(run([[replayTick(500), 0]]), 0);
        const next = nextReplayState(left, liveTick(900), LIVE_SESSION, 50);

        expect(left.replaySeenAt).toBeNull();
        expect(next).toMatchObject({ inReplay: false, frame: 900 });
      });

      it("reads live at once when the exit lands inside a grace already running", () => {
        const inGrace = run([
          [replayTick(500), 0],
          [liveTick(900), 300],
        ]);
        const left = replayLeftForLive(inGrace, 300);

        expect(inGrace).toMatchObject({ inReplay: true, frame: 500 });
        expect(left).toMatchObject({ inReplay: false, frame: 900 });
      });

      it("does not record the replay ticks before iRacing applies the command, so no grace follows them", () => {
        const left = replayLeftForLive(run([[replayTick(500), 0]]), 0);
        const applying = nextReplayState(left, replayTick(500), LIVE_SESSION, 20);
        const live = nextReplayState(applying, liveTick(900), LIVE_SESSION, 40);

        expect(applying).toMatchObject({ inReplay: true, frame: 500, replaySeenAt: null });
        expect(live).toMatchObject({ inReplay: false, frame: 900, liveExitAt: null });
      });

      it("records replay ticks again once a live tick has been seen", () => {
        const left = replayLeftForLive(run([[replayTick(500), 0]]), 0);
        const live = nextReplayState(left, liveTick(900), LIVE_SESSION, 40);
        const reentered = nextReplayState(live, replayTick(600), LIVE_SESSION, 60);
        const blip = nextReplayState(reentered, liveTick(900), LIVE_SESSION, 300);

        expect(blip).toMatchObject({ inReplay: true, frame: 600 });
      });

      it("lapses after the grace when iRacing ignored the command, so the next seek's blip keeps its grace", () => {
        const left = replayLeftForLive(run([[replayTick(500), 0]]), 0);
        const ignored = nextReplayState(left, replayTick(500), LIVE_SESSION, 1_000);
        const blip = nextReplayState(ignored, liveTick(900), LIVE_SESSION, 1_300);

        expect(ignored).toMatchObject({ liveExitAt: null, replaySeenAt: 1_000 });
        expect(blip).toMatchObject({ inReplay: true, frame: 500 });
      });

      it("does nothing in a saved replay, where goToEnd only seeks to the end of the file", () => {
        const state = run([[replayTick(500), 0]], SAVED_REPLAY);

        expect(replayLeftForLive(state, 0)).toBe(state);
      });
    });
  });
});
