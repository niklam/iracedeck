import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeSimConnection } from "./fake-sim-connection.js";
import {
  _resetSimConnection,
  getSimConnection,
  initializeSimConnection,
  isSimConnectionInitialized,
} from "./sim-connection.js";

describe("sim-connection singleton", () => {
  afterEach(() => _resetSimConnection());

  it("serves a disconnected null connection before initialisation", () => {
    const connection = getSimConnection();

    expect(isSimConnectionInitialized()).toBe(false);
    expect(connection.isConnected()).toBe(false);
    expect(connection.activeFlags()).toEqual([]);
    expect(connection.resolveTitleTemplate("Speed {{telemetry.Speed}}")).toBe("Speed {{telemetry.Speed}}");
    expect(() => connection.subscribe("x", vi.fn())).not.toThrow();
    expect(() => connection.unsubscribe("x")).not.toThrow();
  });

  it("serves the initialised connection", () => {
    const fake = createFakeSimConnection();

    initializeSimConnection(fake.connection);

    expect(isSimConnectionInitialized()).toBe(true);
    expect(getSimConnection()).toBe(fake.connection);
  });

  it("refuses a second initialisation", () => {
    initializeSimConnection(createFakeSimConnection().connection);

    expect(() => initializeSimConnection(createFakeSimConnection().connection)).toThrow(/already initialized/);
  });

  it("forgets the connection on reset", () => {
    initializeSimConnection(createFakeSimConnection().connection);
    _resetSimConnection();

    expect(isSimConnectionInitialized()).toBe(false);
  });
});
