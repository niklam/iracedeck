import { beforeEach, describe, expect, it, vi } from "vitest";

const focus = vi.fn();
const movePointerToSim = vi.fn();
const getGlobalSettings = vi.fn();

/** deck-core's pure resolver module — imported by PATH, not through the barrel. */
const SIM_POINTER_TARGET = "../../../deck-core/src/sim-pointer-target.js";

// `resolveSimPointerTarget` is deliberately NOT stubbed: what these tests must
// prove is that a configured target reaches the pointer mover intact, so the real
// resolution has to run (a stub would only assert the stub).
//
// It is reached by relative path rather than as `@iracedeck/deck-core` because
// the BARREL drags in `@iracedeck/iracing-sdk` → `@iracedeck/iracing-native`,
// whose module scope `require()`s the native `.node` addon into this worker.
// That made `pnpm test` crash a fork worker ("Worker exited unexpectedly") in
// roughly one run in five — a non-zero exit that silently drops the worker's
// tests. `sim-pointer-target.ts` itself has zero imports, so importing it
// directly runs the same real code with none of that graph.
//
// Since #1084 the suite sets `IRACEDECK_MOCK=1`, so no worker loads the addon
// and that crash path is not reachable from a test any more. This workaround is
// therefore belt-and-braces rather than load-bearing HERE — it is kept because
// the hazard it describes is still real for non-test consumers, which is the
// same reason `deck-core` declares its own `FocusResult`/`PointerMoveResult`
// constants instead of importing them.
vi.mock("@iracedeck/deck-core", async () => {
  const actual =
    await vi.importActual<typeof import("../../../deck-core/src/sim-pointer-target.js")>(SIM_POINTER_TARGET);

  return {
    focusIRacingNow: focus,
    movePointerToSim,
    getGlobalSettings,
    resolveSimPointerTarget: actual.resolveSimPointerTarget,
    FocusResult: { AlreadyFocused: 0, Focused: 1, WindowNotFound: 2, FocusTimedOut: 3 },
    PointerMoveResult: { Moved: 0, WindowNotFound: 1, Failed: 2 },
  };
});

/** The schema defaults, which resolve to the placement #926 shipped. */
const defaultTarget = {
  mouseToSimAnchorX: "center",
  mouseToSimAnchorY: "top",
  mouseToSimOffsetX: 0,
  mouseToSimOffsetY: 12.5,
};

const { bringPointerToSim } = await import("./mouse-to-sim.js");

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("bringPointerToSim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focus.mockReturnValue(1); // Focused
    movePointerToSim.mockReturnValue(0); // Moved
    getGlobalSettings.mockReturnValue(defaultTarget);
  });

  it("focuses the window before moving the pointer", () => {
    const order: string[] = [];

    focus.mockImplementation(() => {
      order.push("focus");

      return 1;
    });
    movePointerToSim.mockImplementation(() => {
      order.push("move");

      return 0;
    });

    bringPointerToSim(logger);

    expect(order).toEqual(["focus", "move"]);
  });

  it("moves the pointer to the configured target", () => {
    getGlobalSettings.mockReturnValue({
      mouseToSimAnchorX: "right",
      mouseToSimAnchorY: "bottom",
      mouseToSimOffsetX: 0,
      mouseToSimOffsetY: 0,
    });

    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledWith(1, 1);
  });

  it("keeps the pre-#1029 placement when the target is left at its defaults", () => {
    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledWith(0.5, 0.125);
  });

  it("applies an offset measured from the configured anchor", () => {
    getGlobalSettings.mockReturnValue({
      mouseToSimAnchorX: "left",
      mouseToSimAnchorY: "middle",
      mouseToSimOffsetX: 10,
      mouseToSimOffsetY: -25,
    });

    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledWith(0.1, 0.25);
  });

  it("reads the target on every press, so a settings change takes effect immediately", () => {
    bringPointerToSim(logger);
    getGlobalSettings.mockReturnValue({ ...defaultTarget, mouseToSimAnchorY: "bottom", mouseToSimOffsetY: 0 });
    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenNthCalledWith(1, 0.5, 0.125);
    expect(movePointerToSim).toHaveBeenNthCalledWith(2, 0.5, 1);
  });

  it("logs success at info", () => {
    bringPointerToSim(logger);

    expect(logger.info).toHaveBeenCalled();
  });

  it("skips the pointer move when the window is not found", () => {
    focus.mockReturnValue(2); // WindowNotFound

    bringPointerToSim(logger);

    expect(movePointerToSim).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("still moves the pointer when focus could not be attempted", () => {
    focus.mockReturnValue(null); // no focuser injected, or it threw

    bringPointerToSim(logger);

    // Only WindowNotFound is evidence the sim is absent. An unattempted focus says
    // nothing about the window, so an independently working pointer mover must run.
    expect(movePointerToSim).toHaveBeenCalledTimes(1);
  });

  it("still moves the pointer when the window was already focused", () => {
    focus.mockReturnValue(0); // AlreadyFocused

    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledTimes(1);
  });

  it("still moves the pointer when focus times out", () => {
    focus.mockReturnValue(3); // FocusTimedOut

    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledTimes(1);
  });

  it("does not claim success when the pointer move fails", () => {
    movePointerToSim.mockReturnValue(2); // Failed

    bringPointerToSim(logger);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("never throws when the service throws", () => {
    focus.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => bringPointerToSim(logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
