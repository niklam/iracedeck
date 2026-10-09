import { describe, expect, it, vi } from "vitest";

import { hasDialInputContext } from "./dial-context.js";

describe("hasDialInputContext", () => {
  it("passes an input event through to a live context without logging", () => {
    const logger = { debug: vi.fn() };
    const contexts = new Map([["ctx-1", {}]]);

    expect(hasDialInputContext(contexts, "ctx-1", "rotate", logger)).toBe(true);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("drops an input event for a context that is gone, naming the event and the context", () => {
    const logger = { debug: vi.fn() };

    expect(hasDialInputContext(new Map(), "ctx-gone", "touchTap", logger)).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith("Dial touchTap dropped: no context for ctx-gone (it has disappeared)");
  });

  it("never adds an entry to the map it reads", () => {
    const contexts = new Map<string, unknown>();

    hasDialInputContext(contexts, "ctx-gone", "down", { debug: vi.fn() });

    expect(contexts.size).toBe(0);
  });
});
