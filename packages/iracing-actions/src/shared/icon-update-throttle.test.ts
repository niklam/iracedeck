import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IconUpdateThrottle } from "./icon-update-throttle.js";

describe("IconUpdateThrottle", () => {
  let throttle: IconUpdateThrottle;

  beforeEach(() => {
    vi.useFakeTimers();
    throttle = new IconUpdateThrottle(100);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the first call immediately", () => {
    const render = vi.fn();
    throttle.schedule("ctx", render);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid calls into a single trailing flush within the window", async () => {
    const render = vi.fn();

    // 10 changes within 100 ms — first fires immediately, rest are coalesced
    // into one trailing flush at the window boundary.
    throttle.schedule("ctx", render);

    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(10);
      throttle.schedule("ctx", render);
    }

    // Immediate render only so far.
    expect(render).toHaveBeenCalledTimes(1);

    // Advance past the throttle window. The pending timer fires.
    await vi.advanceTimersByTimeAsync(100);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("re-evaluates the render closure at flush time so the latest state always wins", async () => {
    let currentValue = "initial";
    const calls: string[] = [];

    throttle.schedule("ctx", () => {
      calls.push(currentValue);
    });
    expect(calls).toEqual(["initial"]);

    vi.advanceTimersByTime(20);
    currentValue = "second";
    throttle.schedule("ctx", () => {
      calls.push(currentValue);
    });

    vi.advanceTimersByTime(20);
    currentValue = "final";
    throttle.schedule("ctx", () => {
      calls.push(currentValue);
    });

    // Trailing flush picks up `final`, not `second`.
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual(["initial", "final"]);
  });

  it("never fires the trailing flush if no calls arrived inside the window", async () => {
    const render = vi.fn();

    throttle.schedule("ctx", render);
    expect(render).toHaveBeenCalledTimes(1);

    // No further calls, but plenty of time passes.
    await vi.advanceTimersByTimeAsync(500);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("renders immediately again once the window has elapsed since the last send", async () => {
    const render = vi.fn();

    throttle.schedule("ctx", render);
    expect(render).toHaveBeenCalledTimes(1);

    // Wait past the window, then call again — should be immediate, not coalesced.
    await vi.advanceTimersByTimeAsync(150);
    throttle.schedule("ctx", render);
    expect(render).toHaveBeenCalledTimes(2);
    // No pending timer scheduled.
    expect(throttle.pendingFlush.size).toBe(0);
  });

  it("isolates contexts — one key's throttle window does not affect another", async () => {
    const renderA = vi.fn();
    const renderB = vi.fn();

    throttle.schedule("a", renderA);
    throttle.schedule("b", renderB);
    expect(renderA).toHaveBeenCalledTimes(1);
    expect(renderB).toHaveBeenCalledTimes(1);

    // Both contexts get their own coalesce window.
    vi.advanceTimersByTime(20);
    throttle.schedule("a", renderA);
    throttle.schedule("b", renderB);

    await vi.advanceTimersByTimeAsync(100);
    expect(renderA).toHaveBeenCalledTimes(2);
    expect(renderB).toHaveBeenCalledTimes(2);
  });

  it("clear cancels the pending flush so no late render fires after disappear", async () => {
    const render = vi.fn();

    throttle.schedule("ctx", render);
    vi.advanceTimersByTime(20);
    throttle.schedule("ctx", render); // schedules a trailing flush

    expect(throttle.pendingFlush.has("ctx")).toBe(true);
    throttle.clear("ctx");
    expect(throttle.pendingFlush.has("ctx")).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    // Only the immediate render — the trailing one was cancelled.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("clearAll cancels every pending flush", () => {
    throttle.schedule("a", vi.fn());
    throttle.schedule("b", vi.fn());
    vi.advanceTimersByTime(10);
    throttle.schedule("a", vi.fn());
    throttle.schedule("b", vi.fn());

    expect(throttle.pendingFlush.size).toBe(2);
    throttle.clearAll();
    expect(throttle.pendingFlush.size).toBe(0);
    expect(throttle.lastImageSentAt.size).toBe(0);
  });
});
