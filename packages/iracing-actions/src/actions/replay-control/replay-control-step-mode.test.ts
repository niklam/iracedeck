import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { lapMode } from "./replay-control-lap-mode.js";
import { sessionMode } from "./replay-control-session-mode.js";
import { formatReplayClock, recordSides, stepCaption } from "./replay-control-step-mode.js";
import { fakeStepIo, lapsAt, recordSource, sessionsAt } from "./replay-dial-step-io.test-support.js";
import { RECORD_STEPS } from "./replay-record-step.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("a mode sends nothing but through its io");
  }),
  getController: vi.fn(() => {
    throw new Error("a mode reads nothing but through its io");
  }),
}));

const dial = ReplayControlDialSettings.parse({ mode: "lap" });

const LAP_STEPS = { next: RECORD_STEPS["next-lap"], previous: RECORD_STEPS["prev-lap"] };

describe("formatReplayClock", () => {
  it.each<[number | undefined, string]>([
    [0, "0:00"],
    [59.99, "0:59"],
    [83.5, "1:23"],
    [3_725, "62:05"],
    [undefined, ""],
    [-1, ""],
    [Number.NaN, ""],
  ])("formats %s as %j", (seconds, expected) => {
    expect(formatReplayClock(seconds)).toBe(expected);
  });
});

describe("stepCaption", () => {
  it("shows the play state with no run for the target", () => {
    const io = fakeStepIo();

    expect(stepCaption(io, "lap")).toBe("PAUSED");

    io.liveSpeed.mockReturnValue({ speed: 2, slowMotion: false });
    expect(stepCaption(io, "lap")).toBe("2x");
  });

  it.each<[number, string]>([
    [3, "+3"],
    [-2, "-2"],
  ])("shows what the search has left for the target, %i as %j", (count, expected) => {
    const io = fakeStepIo();

    io.pendingSearch.mockImplementation((target) => (target === "incident" ? count : null));

    expect(stepCaption(io, "incident")).toBe(expected);
    expect(stepCaption(io, "lap")).toBe("PAUSED");
  });

  it("shows the play state once nothing is left after the search on its way", () => {
    const io = fakeStepIo();

    io.pendingSearch.mockReturnValue(0);

    expect(stepCaption(io, "lap")).toBe("PAUSED");
  });
});

describe("recordSides", () => {
  const position = (frame: number) => ({ frame, time: undefined, endFrame: undefined, seeking: false });

  it("is dim only on a side where the record has entries and none lies that way", () => {
    const source = recordSource(null, sessionsAt([0, 60_000, 150_000]));
    const steps = { next: RECORD_STEPS["next-session"], previous: RECORD_STEPS["prev-session"] };

    // In the first session, at its landing: nothing before it.
    expect(recordSides(position(120), source, steps)).toEqual({ left: false, right: true });
    // In the middle session: both ways.
    expect(recordSides(position(100_000), source, steps)).toEqual({ left: true, right: true });
    // In the last session, past its landing's window: back to its start, and nothing after it.
    expect(recordSides(position(160_000), source, steps)).toEqual({ left: true, right: false });
  });

  it("is lit both ways with no record, since iRacing's search may still move", () => {
    expect(recordSides(position(5_000), recordSource(null, null), LAP_STEPS)).toEqual({ left: true, right: true });
    expect(recordSides(position(5_000), { ...recordSource(null, null), store: null }, LAP_STEPS)).toEqual({
      left: true,
      right: true,
    });
  });

  it("is lit at the last recorded lap, whose end the record does not hold", () => {
    const source = recordSource(lapsAt([50_000, 53_000, 56_000]), null);

    expect(recordSides(position(57_000), source, LAP_STEPS)).toEqual({ left: true, right: true });
  });

  it("is lit both ways with no position", () => {
    expect(recordSides(null, recordSource(lapsAt([50_000]), null), LAP_STEPS)).toEqual({ left: true, right: true });
  });
});

describe.each([
  ["Lap", lapMode, "lap", "dial-lap", RECORD_STEPS["next-lap"], RECORD_STEPS["prev-lap"]],
  ["Session", sessionMode, "session", "dial-session", RECORD_STEPS["next-session"], RECORD_STEPS["prev-session"]],
] as const)("%s mode: a turn", (_name, mode, target, owner, next, previous) => {
  it.each([1, 5])("of %i detents makes one waited jump to the entry the record step reaches", async (ticks) => {
    const io = fakeStepIo();

    io.recordStep.mockReturnValue({ hit: true, frame: 61_000, steps: ticks, what: "starts" });

    await mode.rotate(ticks, dial, io);

    expect(io.recordStep).toHaveBeenCalledExactlyOnceWith(next, ticks);
    expect(io.recordJump).toHaveBeenCalledExactlyOnceWith(owner, 61_000);
    expect(io.queueSearch).not.toHaveBeenCalled();
  });

  it("counter-clockwise walks the previous way, |ticks| entries", () => {
    const io = fakeStepIo();

    io.recordStep.mockReturnValue({ hit: true, frame: 1_000, steps: 3, what: "starts" });
    void mode.rotate(-3, dial, io);

    expect(io.recordStep).toHaveBeenCalledExactlyOnceWith(previous, 3);
    expect(io.recordJump).toHaveBeenCalledExactlyOnceWith(owner, 1_000);
  });

  it("returns the jump, so the surface redraws when it lands", async () => {
    const io = fakeStepIo();
    let land!: () => void;

    io.recordStep.mockReturnValue({ hit: true, frame: 61_000, steps: 1, what: "starts" });
    io.recordJump.mockReturnValue(new Promise<void>((resolve) => (land = resolve)));

    const turn = mode.rotate(1, dial, io);
    let settled = false;

    void turn?.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    land();
    await turn;
    expect(settled).toBe(true);
  });

  it("with a record that ran out part-way jumps as far as it reaches and drops the rest", () => {
    const io = fakeStepIo();

    io.recordStep.mockReturnValue({ hit: true, frame: 70_000, steps: 2, what: "starts" });
    void mode.rotate(5, dial, io);

    expect(io.recordJump).toHaveBeenCalledExactlyOnceWith(owner, 70_000);
    expect(io.queueSearch).not.toHaveBeenCalled();
    expect(io.logger.debug).toHaveBeenCalledWith(expect.stringContaining("the record ran out, the rest is dropped"));
  });

  it.each(["nothing that way", "gap in the record", "no store", "no cursor"])(
    "with a record miss (%s) hands the whole turn to the paced search",
    (reason) => {
      const io = fakeStepIo();

      io.recordStep.mockReturnValue({ hit: false, reason });
      void mode.rotate(-4, dial, io);

      expect(io.queueSearch).toHaveBeenCalledExactlyOnceWith(owner, target, -4);
      expect(io.recordJump).not.toHaveBeenCalled();
    },
  );

  it("while the search works for this target goes to its count without asking the record", () => {
    const io = fakeStepIo();

    io.isSearchRunning.mockImplementation((t) => t === target);
    void mode.rotate(2, dial, io);

    expect(io.queueSearch).toHaveBeenCalledExactlyOnceWith(owner, target, 2);
    expect(io.recordStep).not.toHaveBeenCalled();
    expect(io.recordJump).not.toHaveBeenCalled();
  });

  it("while the search works for another target asks the record", () => {
    const io = fakeStepIo();

    io.isSearchRunning.mockImplementation((t) => t === "incident");
    io.recordStep.mockReturnValue({ hit: true, frame: 61_000, steps: 1, what: "starts" });
    void mode.rotate(1, dial, io);

    expect(io.recordJump).toHaveBeenCalledOnce();
    expect(io.queueSearch).not.toHaveBeenCalled();
  });
});
