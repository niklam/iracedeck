import { beforeEach, describe, expect, it, vi } from "vitest";

const focus = vi.fn();
const movePointerToSim = vi.fn();

vi.mock("@iracedeck/deck-core", () => ({
  getWindowService: () => ({ focus, movePointerToSim }),
  WindowFocusResult: { AlreadyFocused: 0, Focused: 1, WindowNotFound: 2, FocusTimedOut: 3 },
  PointerMoveResult: { Moved: 0, WindowNotFound: 1, Failed: 2 },
}));

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

  it("moves the pointer using the service's default target", () => {
    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledWith();
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
