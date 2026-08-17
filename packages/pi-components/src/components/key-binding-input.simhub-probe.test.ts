// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _simHubProbe } from "./key-binding-input.js";

// The SimHub probe is mocked so the test controls WHEN each answer arrives.
const probeSimHub = vi.fn<(host: string, port: number) => Promise<{ reachable: boolean; roles: string[] }>>();

vi.mock("./simhub-probe.js", () => ({
  probeSimHub: (host: string, port: number) => probeSimHub(host, port),
  SETTINGS_WINDOW_FLAG: "__irdSettingsWindow",
}));

type GlobalHook = (key: string, onValue: (value: string) => void, fallback: unknown) => void;

describe("ird-key-binding SimHub probe — endpoint changes while a probe is in flight", () => {
  const hooks = new Map<string, (value: string) => void>();

  beforeEach(() => {
    hooks.clear();
    probeSimHub.mockReset();
    _simHubProbe.reset();
    const useGlobalSettings: GlobalHook = vi.fn((key, onValue) => {
      hooks.set(key, onValue);
    });
    (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };
    _simHubProbe.subscribe();
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
    _simHubProbe.reset();
  });

  it("discards the answer of a probe whose endpoint changed while it was pending, and probes the new endpoint next", async () => {
    let resolveFirst!: (value: { reachable: boolean; roles: string[] }) => void;
    probeSimHub.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    probeSimHub.mockResolvedValueOnce({ reachable: true, roles: ["New Role"] });

    const first = _simHubProbe.ensureFetched(); // probes 127.0.0.1:8888
    hooks.get("simHubHost")?.("10.0.0.5"); // endpoint changes mid-flight
    resolveFirst({ reachable: true, roles: ["Old Role"] });
    await first;

    // The stale answer must not be applied nor mark the fetch done for the new endpoint.
    expect(_simHubProbe.state()).toMatchObject({ host: "10.0.0.5", done: false, reachable: false, roles: [] });

    await _simHubProbe.ensureFetched();

    expect(probeSimHub).toHaveBeenLastCalledWith("10.0.0.5", 8888);
    expect(_simHubProbe.state()).toMatchObject({ done: true, reachable: true, roles: ["New Role"] });
  });

  it("applies the answer when the endpoint is unchanged", async () => {
    probeSimHub.mockResolvedValueOnce({ reachable: true, roles: ["b", "A"] });

    await _simHubProbe.ensureFetched();

    expect(probeSimHub).toHaveBeenCalledWith("127.0.0.1", 8888);
    expect(_simHubProbe.state()).toMatchObject({ done: true, reachable: true, roles: ["A", "b"] });
  });
});
