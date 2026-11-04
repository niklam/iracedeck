import { describe, expect, it, vi } from "vitest";

import { PROFILE_REMOVE_ATTEMPTS, PROFILE_REMOVE_RETRY_MS, removeProfileDir } from "./profile-dir.mjs";

function locked() {
  return Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
}

describe("removeProfileDir", () => {
  it("removes the tree in one try, without Node's own retries", async () => {
    const rmImpl = vi.fn(async () => {});
    const delay = vi.fn(async () => {});

    await expect(removeProfileDir("/tmp/profile", { rmImpl, delay })).resolves.toEqual({ removed: true });

    expect(rmImpl).toHaveBeenCalledTimes(1);
    // No maxRetries: Node's back-off on a held file is what hung the run.
    expect(rmImpl).toHaveBeenCalledWith("/tmp/profile", { recursive: true, force: true });
    expect(delay).not.toHaveBeenCalled();
  });

  it("tries again after a short pause while a file is still held", async () => {
    const rmImpl = vi
      .fn()
      .mockRejectedValueOnce(locked())
      .mockRejectedValueOnce(locked())
      .mockResolvedValueOnce(undefined);
    const delay = vi.fn(async () => {});

    await expect(removeProfileDir("/tmp/profile", { rmImpl, delay })).resolves.toEqual({ removed: true });

    expect(rmImpl).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls).toEqual([[PROFILE_REMOVE_RETRY_MS], [PROFILE_REMOVE_RETRY_MS]]);
  });

  it("gives up after its bound and hands back the last error, never throwing", async () => {
    const error = locked();
    const rmImpl = vi.fn(async () => {
      throw error;
    });
    const delay = vi.fn(async () => {});

    await expect(removeProfileDir("/tmp/profile", { rmImpl, delay })).resolves.toEqual({ removed: false, error });

    expect(rmImpl).toHaveBeenCalledTimes(PROFILE_REMOVE_ATTEMPTS);
    // No pause after the last try: nothing follows it.
    expect(delay).toHaveBeenCalledTimes(PROFILE_REMOVE_ATTEMPTS - 1);
  });
});
