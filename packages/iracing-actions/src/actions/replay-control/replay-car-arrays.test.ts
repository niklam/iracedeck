import { REPLAY_LIVE_EDGE_MAX_FRAMES, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { carArraysTrusted } from "./replay-car-arrays.js";

describe("carArraysTrusted", () => {
  const io = (saved: boolean) => ({ isSavedReplay: () => saved });

  it("trusts a saved replay wherever the cursor is", () => {
    expect(carArraysTrusted(io(true), { ReplayFrameNumEnd: 500_000 } as TelemetryData)).toBe(true);
    expect(carArraysTrusted(io(true), null)).toBe(true);
  });

  it(`trusts an in-session replay only within ${REPLAY_LIVE_EDGE_MAX_FRAMES} frames of the end of the tape`, () => {
    expect(REPLAY_LIVE_EDGE_MAX_FRAMES).toBe(120);
    expect(carArraysTrusted(io(false), { ReplayFrameNumEnd: 0 } as TelemetryData)).toBe(true);
    expect(carArraysTrusted(io(false), { ReplayFrameNumEnd: 120 } as TelemetryData)).toBe(true);
    expect(carArraysTrusted(io(false), { ReplayFrameNumEnd: 121 } as TelemetryData)).toBe(false);
    expect(carArraysTrusted(io(false), { ReplayFrameNumEnd: 1_201 } as TelemetryData)).toBe(false);
    expect(carArraysTrusted(io(false), { ReplayFrameNumEnd: -1 } as TelemetryData)).toBe(false);
    expect(carArraysTrusted(io(false), {} as TelemetryData)).toBe(false);
    expect(carArraysTrusted(io(false), null)).toBe(false);
  });
});
