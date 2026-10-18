import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { incidentMode } from "./replay-control-incident-mode.js";
import { fakeStepIo } from "./replay-dial-step-io.test-support.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("a mode sends nothing but through its io");
  }),
  getController: vi.fn(() => {
    throw new Error("a mode reads nothing but through its io");
  }),
}));

const dial = ReplayControlDialSettings.parse({ mode: "incident" });

describe("incidentMode", () => {
  it.each([1, -1, 4, -7])("hands every turn to the paced search, %i detents", (ticks) => {
    const io = fakeStepIo();

    incidentMode.rotate(ticks, dial, io);

    expect(io.queueSearch).toHaveBeenCalledExactlyOnceWith("dial-incident", "incident", ticks);
    expect(io.recordStep).not.toHaveBeenCalled();
    expect(io.recordJump).not.toHaveBeenCalled();
    expect(io.jumpTo).not.toHaveBeenCalled();
  });

  it("hands a turn to the search even while the search works for another target", () => {
    const io = fakeStepIo();

    io.isSearchRunning.mockImplementation((target) => target === "lap");
    incidentMode.rotate(2, dial, io);

    expect(io.queueSearch).toHaveBeenCalledExactlyOnceWith("dial-incident", "incident", 2);
  });

  it("shows the replay time, no caption but its line kept so the time stays in place, and both side marks", () => {
    const io = fakeStepIo();

    expect(incidentMode.view(dial, io)).toEqual({
      value: "1:23",
      caption: "",
      reserveCaption: true,
      sides: { left: true, right: true },
    });
  });

  it("shows the search's count in the caption while it works for incidents, and none once it is spent", () => {
    const io = fakeStepIo();

    io.pendingSearch.mockImplementation((target) => (target === "incident" ? 3 : null));
    expect(incidentMode.view(dial, io).caption).toBe("+3");

    // Another target's count is not this mode's.
    io.pendingSearch.mockImplementation((target) => (target === "lap" ? 3 : null));
    expect(incidentMode.view(dial, io).caption).toBe("");

    io.pendingSearch.mockReturnValue(0);
    expect(incidentMode.view(dial, io).caption).toBe("");
  });

  it("says nothing on a tick read mid-seek, and shows a pending target's time during a jump", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue(null);
    expect(incidentMode.view(dial, io).value).toBeNull();

    io.position.mockReturnValue({ frame: 9_000, time: 150, endFrame: undefined, seeking: true });
    expect(incidentMode.view(dial, io).value).toBe("2:30");
  });

  it("is labelled INCIDENT and describes its turn", () => {
    expect(incidentMode.label).toBe("INCIDENT");
    expect(incidentMode.rotateDescription).toBe("Next / previous incident");
  });
});
