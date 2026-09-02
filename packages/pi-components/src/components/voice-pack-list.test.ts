// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./voice-pack-list.js";

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

function scan(packs: unknown[], problems: unknown[] = []): string {
  return JSON.stringify({ packs, problems });
}

const PACKS = scan([
  { id: "luca", label: "Luca", version: "1.2.0", voices: [{ id: "luca", label: "Luca" }], provenance: "catalog" },
  { id: "nina", label: "Nina", version: "2.0.1", voices: [{ id: "nina", label: "Nina" }], provenance: "sideload" },
]);

const EMPTY = scan([], []);

describe("ird-voice-pack-list", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    el = document.createElement("ird-voice-pack-list");
    document.body.appendChild(el);
  });

  function publish(value: string, key = "_voicePacks"): void {
    mock.callbacks.get(key)?.(value);
  }

  it("says so when nothing is installed", () => {
    expect(el.textContent).toContain("No voice packs installed");
  });

  it("renders a row per installed pack with its version", () => {
    publish(PACKS);

    const rows = el.querySelectorAll(".ird-vp-row");

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Luca");
    expect(rows[0].textContent).toContain("1.2.0");
    expect(rows[1].textContent).toContain("Nina");
  });

  it("goes back to the empty state when the last pack is removed", () => {
    publish(PACKS);
    publish(EMPTY);

    expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(0);
    expect(el.textContent).toContain("No voice packs installed");
  });

  it("replaces rows rather than appending on every republish", () => {
    publish(PACKS);
    publish(PACKS);

    expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(2);
  });

  it("survives malformed JSON without throwing or rendering junk", () => {
    expect(() => publish("{not json")).not.toThrow();
    expect(el.textContent).toContain("No voice packs installed");
  });

  it("drops entries missing the fields it renders instead of showing undefined", () => {
    publish(scan([{ id: "broken" }, { id: "ok", label: "OK", version: "1.0.0", voices: [{ id: "ok", label: "Ok" }] }]));

    const rows = el.querySelectorAll(".ird-vp-row");

    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("OK");
    expect(el.textContent).not.toContain("undefined");
  });

  it("renders a pack label as text, never as markup — a sideloaded pack authors it", () => {
    publish(
      scan([{ id: "x", label: "<img src=x onerror=alert(1)>", version: "1.0.0", voices: [{ id: "x", label: "X" }] }]),
    );

    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("reads the key named by the packs attribute", () => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    const custom = document.createElement("ird-voice-pack-list");
    custom.setAttribute("packs", "_customKey");
    document.body.appendChild(custom);

    mock.callbacks.get("_customKey")?.(PACKS);

    expect(custom.querySelectorAll(".ird-vp-row")).toHaveLength(2);
  });

  describe("ignored packs (#1034)", () => {
    it("names the pack and the reason it was ignored", () => {
      publish(scan([], [{ pack: "luca", reason: "no voice-pack.json" }]));

      const problems = el.querySelectorAll(".ird-vp-problem");

      expect(problems).toHaveLength(1);
      expect(problems[0].textContent).toContain("luca");
      expect(problems[0].textContent).toContain("no voice-pack.json");
    });

    it("does not claim the directory is empty when a pack was found but ignored", () => {
      // The whole point: the reason must be visible. Saying "none installed"
      // over the top of it would hide the row that explains the silence.
      publish(scan([], [{ pack: "luca", reason: "no voice-pack.json" }]));

      expect(el.textContent).not.toContain("No voice packs installed");
    });

    it("shows a pack that loaded and a problem it still reports, together", () => {
      publish(
        scan(
          [{ id: "luca", label: "Luca", version: "1.2.0", voices: [{ id: "luca", label: "Luca" }] }],
          [{ pack: "luca", reason: "no clips found under voice/luca-shouting" }],
        ),
      );

      expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(1);
      expect(el.querySelectorAll(".ird-vp-problem")).toHaveLength(1);
    });

    it("clears problems on a rescan that fixed them", () => {
      publish(scan([], [{ pack: "luca", reason: "no voice-pack.json" }]));
      publish(EMPTY);

      expect(el.querySelectorAll(".ird-vp-problem")).toHaveLength(0);
      expect(el.textContent).toContain("No voice packs installed");
    });

    it("drops a malformed problem entry rather than rendering undefined", () => {
      publish(scan([], [{ pack: "luca" }, { pack: "nina", reason: "declared id does not match its folder name" }]));

      const problems = el.querySelectorAll(".ird-vp-problem");

      expect(problems).toHaveLength(1);
      expect(problems[0].textContent).toContain("nina");
      expect(el.textContent).not.toContain("undefined");
    });

    it("renders a reason as text, never as markup — a sideloaded manifest authors it", () => {
      publish(scan([], [{ pack: "<b>x</b>", reason: "<img src=x onerror=alert(1)>" }]));

      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector("b")).toBeNull();
      expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    });
  });

  describe("provenance badge (#1100)", () => {
    it("says a catalog pack was downloaded", () => {
      publish(
        scan([
          {
            id: "luca",
            label: "Luca",
            version: "1.2.0",
            voices: [{ id: "luca", label: "Luca" }],
            provenance: "catalog",
          },
        ]),
      );

      const badge = el.querySelector(".ird-vp-badge");

      expect(badge?.textContent).toBe("Downloaded");
      expect(badge?.className).toContain("ird-vp-badge-catalog");
    });

    it("says a bundled-seed pack is built in", () => {
      publish(
        scan([
          {
            id: "default",
            label: "Default",
            version: "1.0.0",
            voices: [{ id: "default", label: "Default" }],
            provenance: "bundled-seed",
          },
        ]),
      );

      const badge = el.querySelector(".ird-vp-badge");

      expect(badge?.textContent).toBe("Built-in");
      expect(badge?.className).toContain("ird-vp-badge-bundled-seed");
    });

    it("says a sideloaded pack was installed by hand — informational wording, not an accusation", () => {
      publish(
        scan([
          {
            id: "nina",
            label: "Nina",
            version: "2.0.1",
            voices: [{ id: "nina", label: "Nina" }],
            provenance: "sideload",
          },
        ]),
      );

      const badge = el.querySelector(".ird-vp-badge");

      expect(badge?.textContent).toBe("Installed by hand");
      expect(badge?.className).toContain("ird-vp-badge-sideload");
      expect(el.textContent).not.toMatch(/unsigned|unverified|untrusted|warning/i);
    });

    it("falls back to the least-trusting label rather than dropping the row when provenance is missing", () => {
      publish(scan([{ id: "old", label: "Old Shape", version: "1.0.0", voices: [{ id: "old", label: "Old" }] }]));

      expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(1);

      const badge = el.querySelector(".ird-vp-badge");

      expect(badge?.textContent).toBe("Installed by hand");
      expect(badge?.className).toContain("ird-vp-badge-sideload");
    });

    it("falls back the same way for an unrecognised provenance value", () => {
      publish(
        scan([
          { id: "x", label: "X", version: "1.0.0", voices: [{ id: "x", label: "X" }], provenance: "not-a-real-kind" },
        ]),
      );

      expect(el.querySelector(".ird-vp-badge")?.textContent).toBe("Installed by hand");
    });
  });

  describe("remove (#1100)", () => {
    it("renders one Remove button per installed pack", () => {
      publish(PACKS);

      expect(el.querySelectorAll(".ird-vp-remove-button")).toHaveLength(2);
    });

    it("sends voicePackRemove with the pack's id, immediately, on click — no confirmation step", () => {
      publish(PACKS);

      const buttons = el.querySelectorAll<HTMLButtonElement>(".ird-vp-remove-button");

      buttons[0]?.click();

      expect(mock.send).toHaveBeenCalledWith("sendToPlugin", { event: "voicePackRemove", id: "luca" });
      expect(mock.send).toHaveBeenCalledTimes(1);
    });

    it("does not write settings itself — the row disappears only on the next _voicePacks push", () => {
      publish(PACKS);
      el.querySelectorAll<HTMLButtonElement>(".ird-vp-remove-button")[0]?.click();

      // Removal is a command, not a local mutation: the row is still here
      // until the plugin republishes _voicePacks after actually removing it.
      expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(2);
    });
  });

  it("issues no extra settings read in response to a DOM event", () => {
    // A regression pin mirroring ird-enable-feature's: this component only
    // ever learns about settings through the useGlobalSettings push
    // subscription set up once at connect, and clicking Remove must never
    // trigger a second subscription/read — it only sends a command.
    publish(PACKS);

    const before = mock.useGlobalSettingsCalls;

    el.querySelectorAll<HTMLButtonElement>(".ird-vp-remove-button")[0]?.click();
    document.dispatchEvent(new Event("change", { bubbles: true }));
    document.dispatchEvent(new Event("input", { bubbles: true }));

    expect(mock.useGlobalSettingsCalls).toBe(before);
  });
});
