import type { ReplayMarker, ReplaySessionStore } from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import { markerIndexAt, type ReplayContext, resolveJumpTarget, walkMarkers } from "./replay-markers-ops.js";

vi.mock("@iracedeck/deck-core", () => ({
  getCommands: vi.fn(),
  MARKER_DEDUPE_FRAMES: 60,
  MARKER_DELETE_WINDOW_FRAMES: 600,
  MARKER_PREVIOUS_MIN_BEHIND_FRAMES: 120,
}));

function markers(...frames: number[]): ReplayMarker[] {
  return frames.map((frame) => ({ frame, sessionNum: 0, sessionTimeMs: 0 }));
}

describe("walkMarkers", () => {
  const list = markers(1_000, 2_000, 3_000, 4_000);
  const at = (frame: number) => list.find((m) => m.frame === frame)!;

  it("one step is the first target itself", () => {
    expect(walkMarkers(list, at(2_000), "next", 1).frame).toBe(2_000);
  });

  it("walks forward and back from the first target", () => {
    expect(walkMarkers(list, at(2_000), "next", 3).frame).toBe(4_000);
    expect(walkMarkers(list, at(3_000), "previous", 2).frame).toBe(2_000);
  });

  it("stops at either end without wrapping", () => {
    expect(walkMarkers(list, at(2_000), "next", 99).frame).toBe(4_000);
    expect(walkMarkers(list, at(2_000), "previous", 99).frame).toBe(1_000);
  });

  it("a first target missing from the list is returned as is", () => {
    const stray = { frame: 9_999, sessionNum: 0, sessionTimeMs: 0 };

    expect(walkMarkers(list, stray, "next", 3)).toBe(stray);
  });
});

describe("markerIndexAt", () => {
  const list = markers(1_000, 2_000);

  it("names the marker at the frame or up to 120 frames past it", () => {
    expect(markerIndexAt(list, 2_000)).toBe(1);
    expect(markerIndexAt(list, 2_120)).toBe(1);
    expect(markerIndexAt(list, 1_050)).toBe(0);
  });

  it("is -1 past the window, before the first marker, and with no markers", () => {
    expect(markerIndexAt(list, 2_121)).toBe(-1);
    expect(markerIndexAt(list, 999)).toBe(-1);
    expect(markerIndexAt([], 1_000)).toBe(-1);
  });
});

describe("resolveJumpTarget", () => {
  function context(telemetry: Partial<TelemetryData>): ReplayContext {
    const next = vi.fn(() => markers(5_000)[0]!);
    const previous = vi.fn(() => markers(1_000)[0]!);

    return {
      ok: true,
      telemetry: telemetry as TelemetryData,
      frame: 3_000,
      store: { markers: { next, previous } } as unknown as ReplaySessionStore,
      scope: { subSessionId: 7 },
    };
  }

  it("asks the store's own next / previous from the given frame, scoped", () => {
    const ctx = context({ IsReplayPlaying: true });

    expect(resolveJumpTarget("next", ctx)?.frame).toBe(5_000);
    expect(resolveJumpTarget("previous", ctx, 4_200)?.frame).toBe(1_000);
    expect(ctx.store.markers.next).toHaveBeenCalledWith(3_000, { subSessionId: 7 });
    expect(ctx.store.markers.previous).toHaveBeenCalledWith(4_200, { subSessionId: 7 });
  });

  it("is null out of a replay without asking the store", () => {
    const ctx = context({ IsReplayPlaying: false });

    expect(resolveJumpTarget("next", ctx)).toBeNull();
    expect(resolveJumpTarget("previous", ctx)).toBeNull();
    expect(ctx.store.markers.next).not.toHaveBeenCalled();
  });
});
