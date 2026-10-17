import { describe, expect, it, vi } from "vitest";

import { replayBusyKeyMark, replayBusyMarkKey } from "./replay-busy-mark.js";

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
