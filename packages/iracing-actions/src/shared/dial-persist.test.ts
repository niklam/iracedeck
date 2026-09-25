import { describe, expect, it, vi } from "vitest";

import { persistDialPatch } from "./dial-persist.js";

function setup() {
  return {
    action: { setSettings: vi.fn<(settings: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined) },
    logger: { warn: vi.fn<(message: string) => void>() },
  };
}

describe("persistDialPatch", () => {
  it("merges the patch over the raw dial half, keeping every other key as stored", async () => {
    const { action, logger } = setup();
    const raw = { unit: "l", mode: "toggle-fuel-fill", dial: { mode: "add-amount", stepSize: 5 } };

    const wrote = await persistDialPatch(action, raw, { mode: "fill-to" }, logger, "mode switch");

    expect(wrote).toBe(true);
    expect(action.setSettings).toHaveBeenCalledWith({
      unit: "l",
      mode: "toggle-fuel-fill",
      dial: { mode: "fill-to", stepSize: 5 },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("builds the dial half when the raw settings have none", async () => {
    const { action, logger } = setup();

    await persistDialPatch(action, { setting: "differential-preload" }, { setting: "rr-spring" }, logger, "flip");

    expect(action.setSettings).toHaveBeenCalledWith({
      setting: "differential-preload",
      dial: { setting: "rr-spring" },
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an array", [1]],
    ["a string", "x"],
    ["an empty object", {}],
  ])("writes nothing and warns when the payload is %s", async (_label, raw) => {
    const { action, logger } = setup();

    const wrote = await persistDialPatch(action, raw, { mode: "fill-to" }, logger, "mode switch");

    expect(wrote).toBe(false);
    expect(action.setSettings).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Dial event carried no settings; mode switch not persisted");
  });
});
