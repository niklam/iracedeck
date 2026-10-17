import { describe, expect, it, vi } from "vitest";

import { replayBusyDialMark, replayBusyKeyMark, replayBusyMarkKey } from "./replay-busy-mark.js";

vi.mock("@iracedeck/deck-core", () => ({ BUSY_MARK_FRAMES: 8 }));

describe("replayBusyKeyMark", () => {
  it("draws no mark at rest", () => {
    expect(replayBusyKeyMark({ kind: "rest" })).toBeUndefined();
  });

  it("steps the working ring with the tick, eight frames to a turn", () => {
    expect(replayBusyKeyMark({ kind: "working", tick: 0 })).toEqual({ kind: "working", step: 0 });
    expect(replayBusyKeyMark({ kind: "working", tick: 3 })).toEqual({ kind: "working", step: 3 });
    expect(replayBusyKeyMark({ kind: "working", tick: 8 })).toEqual({ kind: "working", step: 0 });
    expect(replayBusyKeyMark({ kind: "working", tick: 13 })).toEqual({ kind: "working", step: 5 });
  });

  it("draws waiting and not done as their own marks", () => {
    expect(replayBusyKeyMark({ kind: "waiting" })).toEqual({ kind: "waiting" });
    expect(replayBusyKeyMark({ kind: "not-done" })).toEqual({ kind: "not-done" });
  });
});

describe("replayBusyMarkKey", () => {
  it("names each mark, and a working ring by its step", () => {
    expect(replayBusyMarkKey(undefined)).toBe("rest");
    expect(replayBusyMarkKey({ kind: "working", step: 2 })).toBe("working:2");
    expect(replayBusyMarkKey({ kind: "waiting" })).toBe("waiting");
    expect(replayBusyMarkKey({ kind: "not-done" })).toBe("not-done");
  });

  it("tells two steps of the ring apart", () => {
    expect(replayBusyMarkKey({ kind: "working", step: 1 })).not.toBe(replayBusyMarkKey({ kind: "working", step: 2 }));
  });
});

describe("replayBusyDialMark (#1437)", () => {
  it("is no mark at rest, and the still marks as they are", () => {
    expect(replayBusyDialMark({ kind: "rest" })).toBeUndefined();
    expect(replayBusyDialMark({ kind: "waiting" })).toEqual({ kind: "waiting" });
    expect(replayBusyDialMark({ kind: "not-done" })).toEqual({ kind: "not-done" });
  });

  it("steps the working mark on every second tick of the indicator: 0, 0, 1, 1, 2, 2, 0", () => {
    const positions = Array.from({ length: 13 }, (_, tick) => {
      const mark = replayBusyDialMark({ kind: "working", tick });

      return mark?.kind === "working" ? mark.position : -1;
    });

    expect(positions).toEqual([0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0]);
  });
});
