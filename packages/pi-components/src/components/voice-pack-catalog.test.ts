// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration.
import "./voice-pack-catalog.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
  send: ReturnType<typeof vi.fn>;
  useGlobalSettingsCalls: number;
}

function installMockSDPI(): MockSDPIState {
  const send = vi.fn();
  const state: MockSDPIState = { callbacks: new Map(), send, useGlobalSettingsCalls: 0 };

  const useGlobalSettings = (key: string, callback: SettingsCallback): [() => Promise<string>, () => void] => {
    state.callbacks.set(key, callback);
    state.useGlobalSettingsCalls += 1;

    return [async () => "", vi.fn()];
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = {
    useGlobalSettings,
    streamDeckClient: { send },
  };

  return state;
}

function status(catalog: unknown, installs: Record<string, unknown> = {}): string {
  return JSON.stringify({ catalog, installs });
}

function offer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "luca",
    label: "Luca",
    version: "1.3.0",
    bytes: 12_000_000, // 12.0 MB exactly (decimal, as the UI formats) — no rounding ambiguity
    verdict: "install",
    ...overrides,
  };
}

function mount(): { el: HTMLElement; mock: MockSDPIState } {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

  const mock = installMockSDPI();
  const el = document.createElement("ird-voice-pack-catalog");

  document.body.appendChild(el);

  return { el, mock };
}

function publish(mock: MockSDPIState, value: string, key = "_voicePackStatus"): void {
  mock.callbacks.get(key)?.(value);
}

describe("ird-voice-pack-catalog", () => {
  describe("catalog state", () => {
    it("says it could not check, rather than showing an empty list, when the catalog state is unknown", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "unknown" }));

      expect(el.textContent).toContain("Couldn't check for downloadable voice packs");
      // Must not read as "there is nothing to download" — that is a different
      // claim from "we could not check", and the wrong one to make here.
      expect(el.textContent).not.toMatch(/no (downloadable )?voice packs (right now|available)/i);
    });

    it("says so plainly when the catalog is reachable but genuinely empty", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [] }));

      expect(el.textContent).toContain("No downloadable voice packs");
      expect(el.querySelectorAll(".ird-vpc-row")).toHaveLength(0);
    });

    it("renders one row per catalog entry", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status({
          state: "ok",
          packs: [offer({ id: "luca", label: "Luca" }), offer({ id: "nina", label: "Nina", verdict: "installed" })],
        }),
      );

      expect(el.querySelectorAll(".ird-vpc-row")).toHaveLength(2);
    });
  });

  describe("verdicts", () => {
    it("offers Install for a pack that is not installed", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "install" })] }));

      const button = el.querySelector<HTMLButtonElement>(".ird-vpc-button");

      expect(button?.textContent).toBe("Install");

      button?.click();

      expect(mock.send).toHaveBeenCalledWith("sendToPlugin", { event: "voicePackInstall", id: "luca" });
    });

    it("shows the download size next to Install", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "install", bytes: 12_000_000 })] }));

      expect(el.querySelector(".ird-vpc-size")?.textContent).toBe("12.0 MB");
    });

    it("offers Update for a pack whose catalog hash has moved on, and sends the SAME command as Install", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "update" })] }));

      const button = el.querySelector<HTMLButtonElement>(".ird-vpc-button");

      expect(button?.textContent).toBe("Update");

      button?.click();

      expect(mock.send).toHaveBeenCalledWith("sendToPlugin", { event: "voicePackInstall", id: "luca" });
    });

    it("shows no action for a pack that is already installed at this hash", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "installed" })] }));

      expect(el.querySelector(".ird-vpc-button")).toBeNull();
      expect(el.querySelector(".ird-vpc-installed")?.textContent).toBe("Installed");
    });

    it("lists an unsupported pack with an explanation naming the version needed, rather than hiding it", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "unsupported", minPluginVersion: "4.1.0" })] }));

      expect(el.querySelectorAll(".ird-vpc-row")).toHaveLength(1);
      expect(el.querySelector(".ird-vpc-button")).toBeNull();
      expect(el.querySelector(".ird-vpc-unsupported")?.textContent).toContain("4.1.0");
    });

    it("still shows an explanation for unsupported even without a minPluginVersion field", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "unsupported" })] }));

      expect(el.querySelector(".ird-vpc-unsupported")?.textContent).toContain("newer version of iRaceDeck");
    });
  });

  describe("install progress", () => {
    it("shows a readable received/total pair while downloading", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status(
          { state: "ok", packs: [offer({ verdict: "install" })] },
          { luca: { phase: "downloading", receivedBytes: 4_400_000, totalBytes: 13_100_000 } },
        ),
      );

      expect(el.querySelector(".ird-vpc-phase")?.textContent).toContain("Downloading");
      expect(el.querySelector(".ird-vpc-progress")?.textContent).toBe("4.4 / 13.1 MB");
      // No Install button while a download for this pack is already running.
      expect(el.querySelector(".ird-vpc-button")).toBeNull();
    });

    it("uses KB for a small pack rather than '0.0 MB'", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status(
          { state: "ok", packs: [offer({ verdict: "install" })] },
          { luca: { phase: "downloading", receivedBytes: 200_000, totalBytes: 500_000 } },
        ),
      );

      expect(el.querySelector(".ird-vpc-progress")?.textContent).toBe("200 / 500 KB");
    });

    it.each([
      ["verifying", "Verifying"],
      ["extracting", "Extracting"],
      ["swapping", "Installing"],
    ])("shows a phase label for %s with no stale byte progress", (phase, expectedWord) => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "install" })] }, { luca: { phase } }));

      expect(el.querySelector(".ird-vpc-phase")?.textContent).toContain(expectedWord);
      expect(el.querySelector(".ird-vpc-progress")).toBeNull();
    });

    it("progress overrides the verdict's own action even when the verdict still says installed", () => {
      // The catalog snapshot can lag a fresh install starting; the live
      // install record must win regardless of what the verdict currently says.
      const { el, mock } = mount();

      publish(
        mock,
        status(
          { state: "ok", packs: [offer({ verdict: "installed" })] },
          { luca: { phase: "downloading", receivedBytes: 1, totalBytes: 2 } },
        ),
      );

      expect(el.querySelector(".ird-vpc-installed")).toBeNull();
      expect(el.querySelector(".ird-vpc-phase")?.textContent).toContain("Downloading");
    });

    it("shows the failure message and a Retry button that re-sends the install command", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status(
          { state: "ok", packs: [offer({ verdict: "install" })] },
          { luca: { phase: "failed", error: "The download did not match its checksum." } },
        ),
      );

      expect(el.querySelector(".ird-vpc-error")?.textContent).toBe("The download did not match its checksum.");

      const retry = el.querySelector<HTMLButtonElement>(".ird-vpc-button");

      expect(retry?.textContent).toBe("Retry");

      retry?.click();

      expect(mock.send).toHaveBeenCalledWith("sendToPlugin", { event: "voicePackInstall", id: "luca" });
    });

    it("falls back to a generic failure message when none is given", () => {
      const { el, mock } = mount();

      publish(mock, status({ state: "ok", packs: [offer({ verdict: "install" })] }, { luca: { phase: "failed" } }));

      expect(el.querySelector(".ird-vpc-error")?.textContent).toBe("Install failed.");
    });
  });

  describe("untrusted text renders as text, never as markup", () => {
    it("a hostile pack label", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status({
          state: "ok",
          packs: [offer({ label: "<img src=x onerror=alert(1)>" })],
        }),
      );

      expect(el.querySelector("img")).toBeNull();
      expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("a hostile description", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status({
          state: "ok",
          packs: [offer({ description: "<b>bold</b><script>1</script>" })],
        }),
      );

      expect(el.querySelector("b")).toBeNull();
      expect(el.querySelector("script")).toBeNull();
      expect(el.textContent).toContain("<b>bold</b><script>1</script>");
    });

    it("a hostile failure message", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status(
          { state: "ok", packs: [offer({ verdict: "install" })] },
          { luca: { phase: "failed", error: "<img src=x onerror=alert(1)>" } },
        ),
      );

      expect(el.querySelector("img")).toBeNull();
      expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    });
  });

  describe("malformed payloads", () => {
    it("survives unparsable JSON without throwing or rendering junk", () => {
      const { el, mock } = mount();

      expect(() => publish(mock, "{not json")).not.toThrow();
      expect(el.textContent).toContain("Couldn't check");
    });

    it("drops a catalog entry missing the fields it renders instead of showing undefined", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status({
          state: "ok",
          packs: [{ id: "broken" }, offer({ id: "ok", label: "OK" })],
        }),
      );

      expect(el.querySelectorAll(".ird-vpc-row")).toHaveLength(1);
      expect(el.textContent).not.toContain("undefined");
    });

    it("drops an install record with an unrecognised phase rather than inventing one", () => {
      const { el, mock } = mount();

      publish(
        mock,
        status({ state: "ok", packs: [offer({ verdict: "install" })] }, { luca: { phase: "not-a-real-phase" } }),
      );

      // Falls back to the verdict-driven Install action, as if nothing were in flight.
      expect(el.querySelector(".ird-vpc-button")?.textContent).toBe("Install");
    });
  });

  it("issues no extra settings read in response to a DOM event", () => {
    // Mirrors ird-enable-feature's regression pin: this component only ever
    // learns about settings through the useGlobalSettings push subscription
    // set up once at connect. Clicking Install/Update/Retry must never
    // trigger a second subscription/read — it only ever sends a command.
    const { el, mock } = mount();

    publish(mock, status({ state: "ok", packs: [offer({ verdict: "install" })] }));

    const before = mock.useGlobalSettingsCalls;

    el.querySelector<HTMLButtonElement>(".ird-vpc-button")?.click();
    document.dispatchEvent(new Event("change", { bubbles: true }));
    document.dispatchEvent(new Event("input", { bubbles: true }));

    expect(mock.useGlobalSettingsCalls).toBe(before);
  });

  it("reads the key named by the status attribute", () => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    const mock = installMockSDPI();
    const custom = document.createElement("ird-voice-pack-catalog");

    custom.setAttribute("status", "_customStatus");
    document.body.appendChild(custom);

    publish(mock, status({ state: "ok", packs: [offer()] }), "_customStatus");

    expect(custom.querySelectorAll(".ird-vpc-row")).toHaveLength(1);
  });
});
