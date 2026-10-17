import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { lapMode, recordedLapAt } from "./replay-control-lap-mode.js";
import { fakeStepIo, lapsAt, recordSource } from "./replay-dial-step-io.test-support.js";
import { listRecord } from "./replay-record-step.js";

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

/** Laps 1-4 of car 4, the line crossed at 50 000, 53 000, 56 000 and 59 000. */
const LAPS = lapsAt([50_000, 53_000, 56_000, 59_000]);

describe("recordedLapAt", () => {
  it("is the lap whose landing, a second before the line, is the last at or before the frame", () => {
    const source = recordSource(LAPS, null);

    expect(recordedLapAt(54_000, listRecord("lap", source))).toBe(2);
    // At the landing a lap step jumps to: that lap, not the one a second from finishing.
    expect(recordedLapAt(56_000 - 60, listRecord("lap", source))).toBe(3);
    expect(recordedLapAt(56_000 - 61, listRecord("lap", source))).toBe(2);
    expect(recordedLapAt(80_000, listRecord("lap", source))).toBe(4);
  });

  it("is null before the first recorded lap, with no store, no car on camera or no car number", () => {
    expect(recordedLapAt(10_000, listRecord("lap", recordSource(LAPS, null)))).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", { ...recordSource(LAPS, null), store: null }))).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", { ...recordSource(LAPS, null), camCarIdx: undefined }))).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(LAPS, null, 255)))).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(LAPS, null, 7)))).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(null, null)))).toBeNull();
  });
});

describe("lapMode view", () => {
  it("shows the viewed car's lap from the record at the cursor", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "L3", caption: "PAUSED" });
  });

  it("shows the lap at the pending landing while a jump is under way", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.position.mockReturnValue({ frame: 59_000 - 60, time: undefined, endFrame: undefined, seeking: true });

    expect(lapMode.view(dial, io).value).toBe("L4");
  });

  it("shows the replay time, m:ss, with no recorded lap for the car at the cursor", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue({ frame: 5_000, time: 83.5, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io).value).toBe("1:23");
  });

  it("says nothing on a tick read mid-seek, so the box keeps what it showed", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue(null);

    expect(lapMode.view(dial, io).value).toBeNull();
  });

  it("shows the search's count in the caption while it works for laps", () => {
    const io = fakeStepIo();

    io.pendingSearch.mockImplementation((target) => (target === "lap" ? -2 : null));

    expect(lapMode.view(dial, io).caption).toBe("-2");
  });

  it("is labelled LAP and describes its turn", () => {
    expect(lapMode.label).toBe("LAP");
    expect(lapMode.rotateDescription).toBe("Next / previous lap");
  });
});
