import { afterEach, describe, expect, it, vi } from "vitest";

import { abortAfter } from "./abort-after.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("abortAfter", () => {
  it("uses AbortSignal.timeout when the runtime has it", () => {
    const timeout = vi.fn(() => "sentinel" as unknown as AbortSignal);

    vi.stubGlobal("AbortSignal", { timeout });

    expect(abortAfter(5000)).toBe("sentinel");
    expect(timeout).toHaveBeenCalledWith(5000);
  });

  // The reason this file exists. Both copies of this helper carried a fallback
  // that never executes on the runtime we ship (Node >= 24 has
  // AbortSignal.timeout), so nothing had ever run it — which is precisely the
  // branch two copies could have silently diverged on.
  it("falls back to an AbortController where AbortSignal.timeout is missing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("AbortSignal", {});

    const signal = abortAfter(5000);

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    vi.advanceTimersByTime(5000);

    // The effect, not merely that something was returned: a signal that never
    // fires is the exact failure the fallback exists to prevent.
    expect(signal?.aborted).toBe(true);
  });

  it("returns undefined rather than throwing where neither primitive exists", () => {
    vi.stubGlobal("AbortSignal", undefined);
    vi.stubGlobal("AbortController", undefined);

    // A request with no deadline is bad; a plugin process that dies building
    // one is worse, and this helper's callers all treat undefined as "no
    // signal" already.
    expect(abortAfter(5000)).toBeUndefined();
  });
});
