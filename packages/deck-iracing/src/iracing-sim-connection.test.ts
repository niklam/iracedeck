import { type SDKController, templateContextFromMaps } from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_TEMPLATE_CONTEXT, IRacingSimConnection } from "./iracing-sim-connection.js";

// SessionFlags bits (irsdk_Flags): green 0x4, yellow 0x8.
const GREEN = 0x4;
const YELLOW = 0x8;

function fakeController(overrides: Partial<Record<keyof SDKController, unknown>> = {}) {
  return {
    getConnectionStatus: vi.fn(() => true),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getCurrentTelemetry: vi.fn(() => ({ SessionFlags: 0 })),
    getCurrentTemplateContext: vi.fn(() => null),
    ...overrides,
  } as unknown as SDKController;
}

/** Delivers one controller tick carrying `telemetry` to `connection`'s subscription. */
function tick(controller: SDKController, telemetry: unknown, isConnected = true): void {
  const [, callback] = vi.mocked(controller.subscribe).mock.calls[0];
  callback(telemetry as never, isConnected);
}

describe("IRacingSimConnection", () => {
  it("reports the controller's connection status", () => {
    const controller = fakeController({ getConnectionStatus: vi.fn(() => false) });

    expect(new IRacingSimConnection(controller).isConnected()).toBe(false);
  });

  it("forwards ticks with only the connection flag", () => {
    const controller = fakeController();
    const onTick = vi.fn();

    new IRacingSimConnection(controller).subscribe("id-1", onTick);
    const [id, callback] = vi.mocked(controller.subscribe).mock.calls[0];
    callback({ SessionFlags: YELLOW } as never, true);

    expect(id).toBe("id-1");
    expect(onTick).toHaveBeenCalledWith(true);
  });

  it("unsubscribes by id", () => {
    const controller = fakeController();

    new IRacingSimConnection(controller).unsubscribe("id-1");

    expect(controller.unsubscribe).toHaveBeenCalledWith("id-1");
  });

  it("maps SessionFlags to overlay flags", () => {
    const controller = fakeController();
    const connection = new IRacingSimConnection(controller);

    connection.subscribe("id-1", vi.fn());
    tick(controller, { SessionFlags: YELLOW });
    const flags = connection.activeFlags();

    expect(flags.map((f) => f.label)).toContain("YELLOW");
    expect(flags[0]).toEqual(
      expect.objectContaining({ color: expect.any(String), textColor: expect.any(String), pulse: expect.any(Boolean) }),
    );
  });

  it("returns no flags after a disconnected tick", () => {
    const controller = fakeController();
    const connection = new IRacingSimConnection(controller);

    connection.subscribe("id-1", vi.fn());
    tick(controller, { SessionFlags: YELLOW | GREEN });
    tick(controller, { SessionFlags: YELLOW | GREEN }, false);

    expect(connection.activeFlags()).toEqual([]);
  });

  it("returns no flags while disconnected even after a tick carried flags", () => {
    const getConnectionStatus = vi.fn(() => true);
    const controller = fakeController({ getConnectionStatus });
    const connection = new IRacingSimConnection(controller);

    connection.subscribe("id-1", vi.fn());
    const [, callback] = vi.mocked(controller.subscribe).mock.calls[0];
    callback({ SessionFlags: YELLOW } as never, true);
    getConnectionStatus.mockReturnValue(false);

    expect(connection.activeFlags()).toEqual([]);
  });

  it("reads the flags from the tick's own telemetry, without a fresh telemetry read", () => {
    // The controller's current telemetry says no flags; the tick says yellow.
    const controller = fakeController();
    const connection = new IRacingSimConnection(controller);
    let labelsInTick: string[] = [];

    connection.subscribe("id-1", () => {
      labelsInTick = connection.activeFlags().map((f) => f.label);
    });
    const [, callback] = vi.mocked(controller.subscribe).mock.calls[0];
    callback({ SessionFlags: YELLOW } as never, true);

    expect(labelsInTick).toContain("YELLOW");
    expect(controller.getCurrentTelemetry).not.toHaveBeenCalled();
  });

  it("returns no flags before any tick, without reading telemetry", () => {
    const controller = fakeController({ getCurrentTelemetry: vi.fn(() => ({ SessionFlags: YELLOW })) });

    expect(new IRacingSimConnection(controller).activeFlags()).toEqual([]);
    expect(controller.getCurrentTelemetry).not.toHaveBeenCalled();
  });

  it("returns no flags when the tick carried no telemetry", () => {
    const controller = fakeController();
    const connection = new IRacingSimConnection(controller);

    connection.subscribe("id-1", vi.fn());
    tick(controller, null);

    expect(connection.activeFlags()).toEqual([]);
  });

  describe("resolveTitleTemplate", () => {
    it("resolves {{variable}} placeholders against the current template context", () => {
      const controller = fakeController({
        getCurrentTemplateContext: vi.fn(() => templateContextFromMaps({ "track_ahead.car_number": "34" })),
      });

      expect(new IRacingSimConnection(controller).resolveTitleTemplate("CAR {{track_ahead.car_number}}")).toBe(
        "CAR 34",
      );
    });

    it("resolves {{= expression }} placeholders against the raw context", () => {
      const controller = fakeController({
        getCurrentTemplateContext: vi.fn(() => templateContextFromMaps({}, { "self.position": 4 })),
      });

      expect(new IRacingSimConnection(controller).resolveTitleTemplate("P{{= self.position + 1 }}")).toBe("P5");
    });

    it("renders variables empty when there is no template context", () => {
      const controller = fakeController({ getCurrentTemplateContext: vi.fn(() => null) });

      expect(new IRacingSimConnection(controller).resolveTitleTemplate("v={{telemetry.Speed}}")).toBe("v=");
    });

    it("keeps expression parse errors visible when there is no template context", () => {
      const controller = fakeController({ getCurrentTemplateContext: vi.fn(() => null) });

      expect(new IRacingSimConnection(controller).resolveTitleTemplate("{{= self.position + }}")).toBe(
        "{{= self.position + }}",
      );
    });

    it("renders variables empty when reading the context throws", () => {
      const controller = fakeController({
        getCurrentTemplateContext: vi.fn(() => {
          throw new Error("boom");
        }),
      });

      expect(new IRacingSimConnection(controller).resolveTitleTemplate("v={{telemetry.Speed}}")).toBe("v=");
    });

    it("falls back to the empty context when a lazily built namespace throws (#1339)", () => {
      // The live context builds a namespace on its first lookup, inside
      // resolveTemplate; a builder that throws there must not escape.
      const controller = fakeController({
        getCurrentTemplateContext: vi.fn(() => ({
          display: () => {
            throw new Error("malformed driver entry");
          },
          raw: () => {
            throw new Error("malformed driver entry");
          },
        })),
      });
      const connection = new IRacingSimConnection(controller);

      expect(connection.resolveTitleTemplate("CAR {{track_ahead.car_number}}")).toBe("CAR ");
      expect(connection.resolveTitleTemplate("{{= self.position + }}")).toBe("{{= self.position + }}");
    });
  });
});

describe("EMPTY_TEMPLATE_CONTEXT", () => {
  it("is empty and frozen, so a shared fallback cannot be mutated by one consumer", () => {
    expect(Object.isFrozen(EMPTY_TEMPLATE_CONTEXT)).toBe(true);
    expect(EMPTY_TEMPLATE_CONTEXT.display("self.name")).toBeUndefined();
    expect(EMPTY_TEMPLATE_CONTEXT.raw("self.name")).toEqual({ found: false });
    expect(EMPTY_TEMPLATE_CONTEXT.display("constructor")).toBeUndefined();
    expect(EMPTY_TEMPLATE_CONTEXT.raw("toString")).toEqual({ found: false });
  });
});
