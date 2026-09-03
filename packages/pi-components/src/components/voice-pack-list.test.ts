// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import { VOICE_PACK_REMOVE_ARM_MS } from "./voice-pack-list.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
  send: ReturnType<typeof vi.fn>;
  useGlobalSettingsCalls: number;
  readerCalls: number;
}

function installMockSDPI(): MockSDPIState {
  const send = vi.fn();
  const state: MockSDPIState = { callbacks: new Map(), send, useGlobalSettingsCalls: 0, readerCalls: 0 };

  const useGlobalSettings = (key: string, callback: SettingsCallback): [() => Promise<string>, () => void] => {
    state.callbacks.set(key, callback);
    state.useGlobalSettingsCalls += 1;

    // Counted, because subscription count alone would miss the failure this
    // pins: a component that captures the reader once and calls it from a DOM
    // handler. That is precisely what broke the settings window for
    // ird-enable-feature, and it adds no subscription.
    return [
      async () => {
        state.readerCalls += 1;

        return "";
      },
      vi.fn(),
    ];
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

  // The republish has to CHANGE the value or the shared push filter drops it,
  // and then one render produces two rows whether or not the list is cleared
  // first — which is how this test used to pass without testing anything.
  it("replaces rows rather than appending on every republish", () => {
    publish(PACKS);
    publish(
      scan([
        { id: "luca", label: "Luca", version: "1.2.0", voices: [{ id: "luca", label: "Luca" }], provenance: "catalog" },
        {
          id: "vera",
          label: "Vera",
          version: "3.0.0",
          voices: [{ id: "vera", label: "Vera" }],
          provenance: "sideload",
        },
      ]),
    );

    expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(2);
    expect(el.textContent).toContain("Vera");
    expect(el.textContent).not.toContain("Nina");
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

    const removeButtons = () => el.querySelectorAll<HTMLButtonElement>(".ird-vp-remove-button");

    it("arms on the first press and sends nothing", () => {
      publish(PACKS);
      removeButtons()[0]?.click();

      expect(mock.send).not.toHaveBeenCalled();
      expect(removeButtons()[0]?.textContent).toBe("Remove — are you sure?");
      // Only the pressed row arms; its neighbour is untouched.
      expect(removeButtons()[1]?.textContent).toBe("Remove");
    });

    it("sends voicePackRemove on the second press", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      removeButtons()[0]?.click();

      expect(mock.send).toHaveBeenCalledWith("sendToPlugin", { event: "voicePackRemove", id: "luca" });
      expect(mock.send).toHaveBeenCalledTimes(1);
    });

    // The cancel that fires when the user is not there, which is the only one
    // that addresses the hazard a confirmation exists for: a button left armed
    // is one somebody comes back to and presses without reading.
    it("disarms itself after the arming window", () => {
      vi.useFakeTimers();

      try {
        publish(PACKS);
        removeButtons()[0]?.click();
        vi.advanceTimersByTime(VOICE_PACK_REMOVE_ARM_MS);

        expect(removeButtons()[0]?.textContent).toBe("Remove");

        // And the press that follows re-arms rather than removing.
        removeButtons()[0]?.click();

        expect(mock.send).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // Arming used to re-render, which destroyed the button that took the press
    // and dropped focus to the body — leaving the destructive action with no
    // keyboard route: Enter armed a button the user was no longer on.
    it("keeps focus on the button it armed", () => {
      publish(PACKS);

      const button = removeButtons()[0];

      button?.focus();
      button?.click();

      expect(document.activeElement).toBe(button);
      // The very same element, mutated rather than replaced.
      expect(removeButtons()[0]).toBe(button);
      expect(button?.getAttribute("aria-pressed")).toBe("true");
    });

    // A removal that FAILS republishes nothing — the installer writes a warning
    // banner and the plugin dedupes the pack list at source — so nothing would
    // ever have corrected the label if the confirming press did not.
    it("returns the button to rest on the confirming press", () => {
      publish(PACKS);

      const button = removeButtons()[0];

      button?.click();
      button?.click();

      expect(button?.textContent).toBe("Remove");
      expect(button?.getAttribute("aria-pressed")).toBe("false");
    });

    // Provenance is a cell the row displays, so a folder swapped from a catalog
    // copy to a hand-placed one at the same id, version and label is a
    // different pack to the person reading it.
    it("disarms when only the provenance badge changes", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      publish(
        scan([
          {
            id: "luca",
            label: "Luca",
            version: "1.2.0",
            voices: [{ id: "luca", label: "Luca" }],
            provenance: "sideload",
          },
          {
            id: "nina",
            label: "Nina",
            version: "2.0.1",
            voices: [{ id: "nina", label: "Nina" }],
            provenance: "sideload",
          },
        ]),
      );

      expect(removeButtons()[0]?.textContent).toBe("Remove");
    });

    // Falls out of `armed` being a single id rather than a flag per row.
    it("arming another pack disarms the first", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      removeButtons()[1]?.click();

      expect(removeButtons()[0]?.textContent).toBe("Remove");
      expect(removeButtons()[1]?.textContent).toBe("Remove — are you sure?");
      expect(mock.send).not.toHaveBeenCalled();
    });

    // A rescan landing mid-confirmation must not silently disarm: the armed id
    // lives on the element, not in the DOM the render replaces.
    //
    // The push has to CHANGE the value, or the no-rebuild guard short-circuits
    // it and this passes without a render ever happening — which is what it did
    // when it published the identical string twice. So the same packs arrive
    // alongside a new problem row: a real rebuild, the same pack identity.
    it("survives a re-render that keeps the armed pack", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      publish(
        scan(
          [
            {
              id: "luca",
              label: "Luca",
              version: "1.2.0",
              voices: [{ id: "luca", label: "Luca" }],
              provenance: "catalog",
            },
            {
              id: "nina",
              label: "Nina",
              version: "2.0.1",
              voices: [{ id: "nina", label: "Nina" }],
              provenance: "sideload",
            },
          ],
          [{ pack: "vera", reason: "no voice-pack.json" }],
        ),
      );

      // The rebuild really happened: the problem row is new DOM.
      expect(el.querySelectorAll(".ird-vp-problem")).toHaveLength(1);
      expect(removeButtons()[0]?.textContent).toBe("Remove — are you sure?");
    });

    // But a pack that has gone cannot stay armed, or the next pack to take that
    // id would render pre-confirmed.
    it("drops the armed state when the pack leaves the scan", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      publish(scan([{ id: "vixen", label: "Vixen", version: "2.0.0", voices: [{ id: "vixen", label: "Vixen" }] }]));
      publish(PACKS);

      expect(removeButtons()[0]?.textContent).toBe("Remove");
    });

    // Presence of the id is not identity. A pack folder's manifest can be
    // edited in place — same id, new version and label — and the row the user
    // then reads as a different pack must not inherit an arm they gave to what
    // was there before, or their next press removes it as a "first" press.
    it("disarms when the same id comes back as a different pack", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      publish(
        scan([
          { id: "luca", label: "Luca Reworked", version: "2.0.0", voices: [{ id: "luca", label: "Luca" }] },
          { id: "vixen", label: "Vixen", version: "1.0.0", voices: [{ id: "vixen", label: "Vixen" }] },
        ]),
      );

      expect(removeButtons()[0]?.textContent).toBe("Remove");
    });

    // sdpi's useGlobalSettings is not keyed — it re-invokes every callback on
    // every push — so an unrelated key updating once a second during a download
    // would otherwise rebuild these rows continuously. Asserted on node
    // IDENTITY, because "it still says Remove" would pass either way.
    it("does not rebuild the rows for a push that did not change this key", () => {
      publish(PACKS);

      const before = removeButtons()[0];

      publish(PACKS);

      expect(removeButtons()[0]).toBe(before);
    });

    it("does not write settings itself — the row disappears only on the next _voicePacks push", () => {
      publish(PACKS);
      removeButtons()[0]?.click();
      removeButtons()[0]?.click();

      // Removal is a command, not a local mutation: the row is still here
      // until the plugin republishes _voicePacks after actually removing it.
      expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(2);
    });
  });

  // #1100. The seeded pack is LISTED so the card cannot read "No voice packs
  // installed" while the button beside it opens a folder plainly containing it
  // — but it is not a pack the user can remove.
  describe("a bundled seed is listed and offers no Remove (#1100)", () => {
    // No voices: the plugin's own audio provides `default`, so the pack
    // contributes nothing. This is the shape the scanner now emits.
    const seed = { id: "default", label: "Default", version: "1.0.0", voices: [], provenance: "bundled-seed" };

    it("renders a row even though the pack provides no voices", () => {
      publish(scan([seed]));

      expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(1);
      expect(el.textContent).toContain("Default");
      expect(el.textContent).not.toContain("No voice packs installed");
    });

    it("offers no Remove button on that row", () => {
      publish(scan([seed]));

      expect(el.querySelector(".ird-vp-remove-button")).toBeNull();
    });

    // A STATEMENT, not a disabled control. The plugin re-seeds this pack on the
    // next start, so a Remove would delete the folder and then appear not to
    // have worked — worse than no button. A disabled one would be worse again:
    // it still invites the click and still has to explain itself.
    it("says where the voice came from in place of the button", () => {
      publish(scan([seed]));

      expect(el.querySelector(".ird-vp-note")?.textContent).toBe("Included with the plugin");
      expect(el.querySelector("button[disabled]")).toBeNull();
    });

    // The exemption must not reach a pack the user genuinely can remove.
    it.each([["catalog"], ["sideload"]])("still offers Remove on a %s pack", (provenance) => {
      publish(
        scan([{ id: "luca", label: "Luca", version: "1.2.0", voices: [{ id: "luca", label: "Luca" }], provenance }]),
      );

      expect(el.querySelector(".ird-vp-remove-button")).not.toBeNull();
      expect(el.querySelector(".ird-vp-note")).toBeNull();
    });
  });

  it("issues no extra settings read in response to a DOM event", () => {
    // A regression pin mirroring ird-enable-feature's: this component only
    // ever learns about settings through the useGlobalSettings push
    // subscription set up once at connect, and clicking Remove must never
    // trigger a second subscription/read — it only sends a command.
    publish(PACKS);

    const subscriptionsBefore = mock.useGlobalSettingsCalls;
    const readsBefore = mock.readerCalls;

    el.querySelectorAll<HTMLButtonElement>(".ird-vp-remove-button")[0]?.click();
    document.dispatchEvent(new Event("change", { bubbles: true }));
    document.dispatchEvent(new Event("input", { bubbles: true }));

    expect(mock.useGlobalSettingsCalls).toBe(subscriptionsBefore);
    expect(mock.readerCalls).toBe(readsBefore);
  });
});
