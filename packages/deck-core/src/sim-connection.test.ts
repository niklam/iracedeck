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

  it("serves a disconnected pending connection before initialisation", () => {
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

  it("replays a subscription made before initialisation onto the connection", () => {
    const onTick = vi.fn();
    getSimConnection().subscribe("early", onTick);

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);
    fake.tick();

    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick).toHaveBeenCalledWith(true);
  });

  it("replays queued subscriptions in the order they were made", () => {
    getSimConnection().subscribe("first", vi.fn());
    getSimConnection().subscribe("second", vi.fn());

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect([...fake.subscribers.keys()]).toEqual(["first", "second"]);
  });

  it("does not replay a subscription withdrawn before initialisation", () => {
    getSimConnection().subscribe("early", vi.fn());
    getSimConnection().unsubscribe("early");

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect(fake.subscribers.size).toBe(0);
  });

  it("delegates to the connection once set, through a pending reference kept from before", () => {
    const kept = getSimConnection();
    const fake = createFakeSimConnection();
    fake.state.flags = [{ label: "YELLOW", color: "#f1c40f", textColor: "#1a1a1a", pulse: false }];
    fake.state.resolve = () => "resolved";
    initializeSimConnection(fake.connection);

    const onTick = vi.fn();
    kept.subscribe("late", onTick);
    fake.tick();

    expect(onTick).toHaveBeenCalledWith(true);
    expect(kept.isConnected()).toBe(true);
    expect(kept.activeFlags()).toEqual(fake.state.flags);
    expect(kept.resolveTitleTemplate("{{x}}")).toBe("resolved");

    kept.unsubscribe("late");
    expect(fake.subscribers.has("late")).toBe(false);
  });

  it("forgets queued subscriptions on reset", () => {
    getSimConnection().subscribe("early", vi.fn());
    _resetSimConnection();

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect(fake.subscribers.size).toBe(0);
  });

  it("forgets the connection on reset", () => {
    initializeSimConnection(createFakeSimConnection().connection);
    _resetSimConnection();

    expect(isSimConnectionInitialized()).toBe(false);
  });
});
