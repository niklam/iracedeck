import { describe, expect, it, vi } from "vitest";

import { callAddonSetSessionIdentity } from "./index.js";

describe("callAddonSetSessionIdentity (#1253)", () => {
  it("reports false instead of throwing when the loaded binary predates setSessionIdentity", () => {
    expect(callAddonSetSessionIdentity({}, "iRaceDeck", "C:/plugin/imgs/plugin/iracedeck.ico")).toBe(false);
  });

  it("forwards both arguments and the result to a binary that has it", () => {
    const setSessionIdentity = vi.fn<(displayName: string, iconPath?: string) => boolean>(() => true);

    expect(callAddonSetSessionIdentity({ setSessionIdentity }, "iRaceDeck", "C:/icon.ico")).toBe(true);
    expect(setSessionIdentity).toHaveBeenCalledWith("iRaceDeck", "C:/icon.ico");
  });

  it("passes on the binary's refusal", () => {
    const setSessionIdentity = vi.fn<(displayName: string, iconPath?: string) => boolean>(() => false);

    expect(callAddonSetSessionIdentity({ setSessionIdentity }, "iRaceDeck")).toBe(false);
    expect(setSessionIdentity).toHaveBeenCalledWith("iRaceDeck", undefined);
  });
});
