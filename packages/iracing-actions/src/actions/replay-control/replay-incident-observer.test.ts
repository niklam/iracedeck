import type { ReplayIncident } from "@iracedeck/replay-store";
import { describe, expect, it, vi } from "vitest";

import { nearestIncident, observeIncidentSearch } from "./replay-incident-observer.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("the observer sends nothing");
  }),
  getController: vi.fn(() => {
    throw new Error("the observer reads through its host");
  }),
}));

function incident(frame: number, carIdx: number): ReplayIncident {
  return {
    frame,
    carIdx,
    carNumberRaw: carIdx + 100,
    sessionNum: 0,
    sessionUniqueId: 1,
    delta: 1,
    source: "telemetry",
    sessionTimeMs: 0,
  };
}

describe("nearestIncident", () => {
  it("is the incident nearest the frame, the earlier one on a tie", () => {
    const list = [incident(1_000, 1), incident(2_000, 2), incident(3_000, 3)];

    expect(nearestIncident(list, 2_400)?.carIdx).toBe(2);
    expect(nearestIncident(list, 2_500)?.carIdx).toBe(2);
    expect(nearestIncident(list, 2_501)?.carIdx).toBe(3);
    expect(nearestIncident(list, 0)?.carIdx).toBe(1);
  });

  it("is null for no incidents", () => {
    expect(nearestIncident([], 1_000)).toBeNull();
  });
});

describe("observeIncidentSearch on a press whose search did not go out now", () => {
  const press = { label: "Next incident", frame: 5_000, camCarIdx: 3 };

  it.each<[Parameters<typeof observeIncidentSearch>[0], string]>([
    [{ kind: "held" }, "held"],
    [{ kind: "taking-over", ok: true }, "taking-over"],
    [{ kind: "not-sent", reason: "nothing" }, "not-sent"],
    [{ kind: "sent", ok: false }, "refused"],
  ])("%o compares nothing and reads nothing", async (result, what) => {
    const host = { logger: { debug: vi.fn(), error: vi.fn() }, readTelemetry: vi.fn(), listIncidents: vi.fn() };

    await observeIncidentSearch(result, press, host);

    expect(host.logger.debug).toHaveBeenCalledExactlyOnceWith(
      `Next incident comparison: search ${what}; press frame=5000 camCar=3; nothing compared`,
    );
    expect(host.readTelemetry).not.toHaveBeenCalled();
    expect(host.listIncidents).not.toHaveBeenCalled();
  });
});
