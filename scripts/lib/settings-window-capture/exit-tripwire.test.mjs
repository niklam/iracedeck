import { describe, expect, it, vi } from "vitest";

import { armExitTripwire, EXIT_TRIPWIRE_MS } from "./exit-tripwire.mjs";

/** A timer double: records what was armed and lets the test fire it. */
function createTimer() {
  const timer = { unref: vi.fn() };
  /** @type {{fire: () => void, ms: number} | undefined} */
  let armed;

  return {
    timer,
    setTimer: vi.fn((fire, ms) => {
      armed = { fire, ms };

      return timer;
    }),
    get armed() {
      return armed;
    },
  };
}

describe("armExitTripwire", () => {
  it("arms one unref'd timer, so a healthy run exits before it can fire", () => {
    const clock = createTimer();
    const exit = vi.fn();
    const report = vi.fn();

    const returned = armExitTripwire({ setTimer: clock.setTimer, exit, report });

    expect(clock.setTimer).toHaveBeenCalledTimes(1);
    expect(clock.armed?.ms).toBe(EXIT_TRIPWIRE_MS);
    expect(clock.timer.unref).toHaveBeenCalledTimes(1);
    expect(returned).toBe(clock.timer);
    // Arming alone says nothing and ends nothing.
    expect(report).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("when it fires, says the process outlived its output, names what holds it, and exits 1", () => {
    const clock = createTimer();
    const exit = vi.fn();
    const report = vi.fn();

    armExitTripwire({
      ms: 2_000,
      setTimer: clock.setTimer,
      exit,
      report,
      activeResources: () => ({
        resources: ["FSReqCallback", "Timeout", "Timeout", "TCPWRAP"],
        handles: ["Socket"],
      }),
    });
    clock.armed?.fire();

    expect(report.mock.calls.map(([line]) => line)).toEqual([
      "The capture finished, but the process was still running 2000 ms after its last output: " +
        "something is holding the event loop open.",
      "Active resources: FSReqCallback, Timeout ×2, TCPWRAP",
      "Active handles: Socket",
    ]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("ends its report with the caller's hint, before it exits", () => {
    const clock = createTimer();
    /** @type {string[]} */
    const order = [];
    const report = vi.fn((line) => order.push(`report:${line}`));
    const exit = vi.fn((code) => order.push(`exit:${code}`));

    armExitTripwire({
      setTimer: clock.setTimer,
      exit,
      report,
      activeResources: () => ({ resources: ["Timeout"], handles: [] }),
      hint: "Restore the tree with `git restore`.",
    });
    clock.armed?.fire();

    expect(order).toEqual([
      `report:The capture finished, but the process was still running ${EXIT_TRIPWIRE_MS} ms after its last output: ` +
        "something is holding the event loop open.",
      "report:Active resources: Timeout",
      "report:Active handles: none",
      "report:Restore the tree with `git restore`.",
      "exit:1",
    ]);
  });

  it("prints exactly the three lines without a hint, or with an empty one", () => {
    for (const hint of [undefined, ""]) {
      const clock = createTimer();
      const report = vi.fn();

      armExitTripwire({
        setTimer: clock.setTimer,
        exit: vi.fn(),
        report,
        activeResources: () => ({ resources: ["Timeout"], handles: [] }),
        ...(hint === undefined ? {} : { hint }),
      });
      clock.armed?.fire();

      expect(report.mock.calls.map(([line]) => line)).toEqual([
        `The capture finished, but the process was still running ${EXIT_TRIPWIRE_MS} ms after its last output: ` +
          "something is holding the event loop open.",
        "Active resources: Timeout",
        "Active handles: none",
      ]);
    }
  });

  it("says none when Node lists nothing", () => {
    const clock = createTimer();
    const report = vi.fn();

    armExitTripwire({
      setTimer: clock.setTimer,
      exit: vi.fn(),
      report,
      activeResources: () => ({ resources: [], handles: [] }),
    });
    clock.armed?.fire();

    expect(report).toHaveBeenCalledWith("Active resources: none");
    expect(report).toHaveBeenCalledWith("Active handles: none");
  });

  it("reads this process's real resources when none are injected", () => {
    const clock = createTimer();
    const report = vi.fn();

    armExitTripwire({ setTimer: clock.setTimer, exit: vi.fn(), report });
    clock.armed?.fire();

    const lines = report.mock.calls.map(([line]) => line);
    expect(lines[1]).toMatch(/^Active resources: \S/);
    expect(lines[2]).toMatch(/^Active handles: \S/);
  });

  it("arms a real, unref'd timer by default", () => {
    const exit = vi.fn();
    const timer = armExitTripwire({ exit, report: vi.fn() });

    try {
      expect(/** @type {NodeJS.Timeout} */ (timer).hasRef()).toBe(false);
    } finally {
      clearTimeout(/** @type {NodeJS.Timeout} */ (timer));
    }

    expect(exit).not.toHaveBeenCalled();
  });
});
