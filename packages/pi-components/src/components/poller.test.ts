// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSharedPoller, installSharedPoller, POLL_INTERVAL_MS } from "./poller.js";

/** Minimal timer host so each test gets an isolated, spy-able window surface. */
function timerHost(): Pick<Window, "setInterval" | "clearInterval"> {
  return {
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  } as Pick<Window, "setInterval" | "clearInterval">;
}

describe("createSharedPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes a registered callback on every poll tick", () => {
    const poller = createSharedPoller(timerHost());
    const callback = vi.fn();

    poller.register(callback);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);

    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("does not start a timer before the first callback registers", () => {
    const host = timerHost();
    const setIntervalSpy = vi.spyOn(host, "setInterval");

    createSharedPoller(host);

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("shares a single interval across multiple callbacks", () => {
    const host = timerHost();
    const setIntervalSpy = vi.spyOn(host, "setInterval");
    const poller = createSharedPoller(host);
    const first = vi.fn();
    const second = vi.fn();

    poller.register(first);
    poller.register(second);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps running later callbacks when an earlier one throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const poller = createSharedPoller(timerHost());
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const after = vi.fn();

    poller.register(throwing);
    poller.register(after);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    expect(after).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("stops invoking a callback after its unregister function is called", () => {
    const poller = createSharedPoller(timerHost());
    const callback = vi.fn();

    const unregister = poller.register(callback);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    unregister();
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("clears the interval when the last callback unregisters", () => {
    const host = timerHost();
    const clearIntervalSpy = vi.spyOn(host, "clearInterval");
    const poller = createSharedPoller(host);

    const unregister = poller.register(vi.fn());
    unregister();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the interval but keeps callbacks for resume()", () => {
    const host = timerHost();
    const clearIntervalSpy = vi.spyOn(host, "clearInterval");
    const poller = createSharedPoller(host);
    const callback = vi.fn();

    poller.register(callback);
    poller.stop();
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();

    poller.resume();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stop() without a running timer is a no-op", () => {
    const host = timerHost();
    const clearIntervalSpy = vi.spyOn(host, "clearInterval");
    const poller = createSharedPoller(host);

    poller.stop();

    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });

  it("resume() without registered callbacks does not start a timer", () => {
    const host = timerHost();
    const setIntervalSpy = vi.spyOn(host, "setInterval");
    const poller = createSharedPoller(host);

    poller.resume();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("registering after stop() restarts the timer", () => {
    const poller = createSharedPoller(timerHost());
    const callback = vi.fn();

    poller.register(vi.fn());
    poller.stop();
    poller.register(callback);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("installSharedPoller", () => {
  /** Minimal window-like install target with spy-able lifecycle listeners. */
  function installTarget() {
    const listeners = new Map<string, EventListener[]>();
    const target = {
      irdPoll: undefined as ((callback: () => void) => () => void) | undefined,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      addEventListener(type: string, listener: EventListener) {
        const existing = listeners.get(type) ?? [];
        existing.push(listener);
        listeners.set(type, existing);
      },
    };
    const fire = (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type));
    };

    return { target, fire };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exposes irdPoll on the target window", () => {
    const { target } = installTarget();

    installSharedPoller(target);
    const callback = vi.fn();
    target.irdPoll?.(callback);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second install keeps the existing irdPoll", () => {
    const { target } = installTarget();

    installSharedPoller(target);
    const first = target.irdPoll;
    installSharedPoller(target);

    expect(target.irdPoll).toBe(first);
  });

  it("stops polling on pagehide and resumes on pageshow", () => {
    const { target, fire } = installTarget();
    installSharedPoller(target);
    const callback = vi.fn();
    target.irdPoll?.(callback);

    fire("pagehide");
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);

    expect(callback).not.toHaveBeenCalled();

    fire("pageshow");
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
