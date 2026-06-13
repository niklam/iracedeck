import type StreamDeck from "@elgato/streamdeck";
import { describe, expect, it, vi } from "vitest";

import { ElgatoPlatformAdapter } from "./adapter.js";

describe("ElgatoPlatformAdapter.openUrl", () => {
  it("should delegate to streamDeck.system.openUrl", async () => {
    const sdMock = {
      system: { openUrl: vi.fn().mockResolvedValue(undefined) },
    } as unknown as typeof StreamDeck;

    const adapter = new ElgatoPlatformAdapter(sdMock);
    await adapter.openUrl("https://example.test/");

    expect(sdMock.system.openUrl).toHaveBeenCalledTimes(1);
    expect(sdMock.system.openUrl).toHaveBeenCalledWith("https://example.test/");
  });
});
