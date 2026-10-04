import { getCommands, type ReplayMarker, type ReplaySessionStore } from "@iracedeck/deck-core";
import { ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  pendingReplayLanding,
  recordReplayLanding,
} from "../../shared/replay-cursor.js";
import {
  DIAL_LANDING_HOLD_MS,
  jumpToMarkerFrame,
  markerIndexAt,
  previewAddMarker,
  type ReplayContext,
  resolveAnchorFrame,
  resolveJumpTarget,
  resolveMarkerJumpAnchor,
  walkMarkers,
} from "./replay-markers-ops.js";

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

describe("resolveAnchorFrame", () => {
  it("keeps the target only while pending", () => {
    const landing = { frame: 2_000, sentAt: 10_000 };

    expect(resolveAnchorFrame(null, 500, 10_000)).toBe(500);
    expect(resolveAnchorFrame(landing, 500, 10_500)).toBe(2_000);
    expect(resolveAnchorFrame(landing, 500, 10_000 + DIAL_LANDING_HOLD_MS)).toBe(500);
    expect(resolveAnchorFrame(landing, 1_950, 10_100)).toBe(1_950);
  });
});

describe("the shared landing (#1230)", () => {
  const setPlayPosition = vi.fn((_mode: number, _frame: number) => true);

  beforeEach(() => {
    _resetReplayCursor();
    setPlayPosition.mockReset().mockReturnValue(true);
    vi.mocked(getCommands).mockReturnValue({ replay: { setPlayPosition } } as never);
  });

  it("a jump that was sent records its target", () => {
    expect(jumpToMarkerFrame("next", 4_000, 10_000)).toBe(true);

    expect(setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 4_000);
    expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: 10_000 });
  });

  it("a jump that was not sent leaves the landing before it standing", () => {
    jumpToMarkerFrame("dial-next", 2_000, 10_000);
    setPlayPosition.mockReturnValue(false);

    expect(jumpToMarkerFrame("next", 4_000, 10_100)).toBe(false);

    expect(pendingReplayLanding()).toEqual({ frame: 2_000, sentAt: 10_000 });
  });

  it("a jump that was not sent records nothing", () => {
    setPlayPosition.mockReturnValue(false);

    expect(jumpToMarkerFrame("next", 4_000, 10_000)).toBe(false);

    expect(pendingReplayLanding()).toBeNull();
  });

  it("the anchor is the landing while it is pending, from any surface", () => {
    jumpToMarkerFrame("dial-next", 4_000, 10_000);

    expect(resolveMarkerJumpAnchor(500, 10_200)).toBe(4_000);
    expect(pendingReplayLanding()).not.toBeNull();
  });

  it("a settled landing anchors no more and is dropped, so a later drift cannot revive it", () => {
    jumpToMarkerFrame("next", 4_000, 10_000);

    expect(resolveMarkerJumpAnchor(3_990, 10_100)).toBe(3_990);
    expect(pendingReplayLanding()).toBeNull();
    expect(resolveMarkerJumpAnchor(500, 10_200)).toBe(500);
  });

  it("an expired landing is dropped", () => {
    recordReplayLanding(4_000, 10_000);

    expect(resolveMarkerJumpAnchor(500, 10_000 + DIAL_LANDING_HOLD_MS)).toBe(500);
    expect(pendingReplayLanding()).toBeNull();
  });

  it("another owner taking the cursor clears it", () => {
    jumpToMarkerFrame("next", 4_000, 10_000);

    cancelReplayCursorOwner("play-pause");

    expect(resolveMarkerJumpAnchor(500, 10_100)).toBe(500);
  });
});

describe("previewAddMarker", () => {
  function context(active: { subSessionId: number } | null, scope?: { subSessionId: number }): ReplayContext {
    return {
      ok: true,
      telemetry: {
        IsReplayPlaying: true,
        ReplayFrameNum: 3_000,
        ReplaySessionNum: 1,
        ReplaySessionTime: 50,
      } as TelemetryData,
      frame: 3_000,
      store: {
        markers: { list: () => markers(1_000) },
        getActiveSession: () => active,
      } as unknown as ReplaySessionStore,
      scope,
    };
  }

  it("names the marker an Add would store", () => {
    expect(previewAddMarker(context({ subSessionId: 7 }, { subSessionId: 7 }), 5)?.frame).toBe(2_700);
    expect(previewAddMarker(context({ subSessionId: 7 }), 5)?.frame).toBe(2_700);
  });

  it("is null with no active record, since the store would refuse the Add", () => {
    expect(previewAddMarker(context(null, { subSessionId: 7 }), 5)).toBeNull();
    expect(previewAddMarker(context(null), 5)).toBeNull();
  });

  it("is null when the active record is another session's", () => {
    expect(previewAddMarker(context({ subSessionId: 8 }, { subSessionId: 7 }), 5)).toBeNull();
  });

  it("is null for a duplicate", () => {
    expect(previewAddMarker(context({ subSessionId: 7 }, { subSessionId: 7 }), 33)).toBeNull();
  });
});
