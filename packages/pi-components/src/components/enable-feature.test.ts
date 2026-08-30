// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./enable-feature.js";

type Handler = (ev: { payload: { settings: Record<string, unknown> } }) => void;

let settings: Record<string, unknown> = {};
let handlers: Handler[] = [];
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  settings = {};
  handlers = [];
  send = vi.fn().mockResolvedValue(undefined);

  (window as unknown as { SDPIComponents: unknown }).SDPIComponents = {
    streamDeckClient: {
      send,
      getGlobalSettings: () => Promise.resolve(settings),
      didReceiveGlobalSettings: {
        subscribe: (fn: Handler) => handlers.push(fn),
        unsubscribe: (fn: Handler) => (handlers = handlers.filter((h) => h !== fn)),
      },
    },
  };
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Mount the element and let the getGlobalSettings() promise settle. */
async function mount(feature: string): Promise<HTMLElement> {
  const el = document.createElement("ird-enable-feature");

  el.setAttribute("feature", feature);
  document.body.appendChild(el);
  await Promise.resolve();
  await Promise.resolve();

  return el;
}

const button = (el: HTMLElement) => el.querySelector("button");
const push = (next: Record<string, unknown>) => handlers.forEach((fn) => fn({ payload: { settings: next } }));

describe("ird-enable-feature", () => {
  describe("the Race Engineer opt-in", () => {
    it("offers to turn it on while it is off", async () => {
      const el = await mount("race-engineer");

      expect(button(el)?.textContent).toBe("Turn on the Race Engineer");
    });

    it("asks the PLUGIN to do it, rather than writing settings itself", async () => {
      // The two-key write has to happen where it can be tested next to the gate
      // table (`enableFeatureWrites`). A control that wrote its own settings
      // could only ever write one key.
      const el = await mount("race-engineer");

      button(el)?.click();

      expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "enableFeature", feature: "race-engineer" });
    });

    it("does not flip itself on press — the arriving settings do that", async () => {
      // So the confirmation means the write landed, not that a button was
      // pressed.
      const el = await mount("race-engineer");

      button(el)?.click();
      await Promise.resolve();

      expect(button(el)).not.toBeNull();

      push({ pitCrewRaceEngineerEnabled: true });

      expect(button(el)).toBeNull();
      expect(el.textContent).toContain("The Race Engineer is on");
    });

    it("shows the truth to somebody who enabled it elsewhere", async () => {
      settings = { pitCrewRaceEngineerEnabled: true };

      const el = await mount("race-engineer");

      expect(button(el)).toBeNull();
    });

    it("accepts the string form the PI persists", async () => {
      settings = { pitCrewRaceEngineerEnabled: "true" };

      expect(button(await mount("race-engineer"))).toBeNull();
    });
  });

  describe("the changelog opt-in", () => {
    it("offers while the policy is never", async () => {
      settings = { changelogNotification: "never" };

      expect(button(await mount("changelog-updates"))?.textContent).toBe("I want to read about new features");
    });

    it("is already satisfied by any policy that opens the notes at all", async () => {
      // Offering to turn on something already on would be a lie, whichever of
      // the three opted-in cadences the user picked.
      for (const policy of ["always", "features", "monthly"]) {
        settings = { changelogNotification: policy };
        document.body.replaceChildren();

        expect(button(await mount("changelog-updates")), `policy ${policy}`).toBeNull();
      }
    });
  });

  describe("the Focus iRacing Window suggestion", () => {
    it("renders nothing on a fresh install, where the setting already defaults on", async () => {
      // `.default(true)` since #930, so an absent value means ON. This is why
      // the suggestion barely reaches its intended audience — long-standing
      // users who turned it off — and that is known and accepted (#1061).
      const el = await mount("focus-iracing-window");

      expect(el.textContent).toBe("");
    });

    it("offers only when the setting is actually off", async () => {
      settings = { focusIRacingWindow: false };

      expect(button(await mount("focus-iracing-window"))?.textContent).toBe("Turn on Focus iRacing Window");
    });

    it("says nothing at all once it is on, rather than confirming", async () => {
      settings = { focusIRacingWindow: false };

      const el = await mount("focus-iracing-window");

      push({ focusIRacingWindow: true });

      expect(el.textContent).toBe("");
    });
  });

  it("renders nothing before the settings have arrived", async () => {
    // An offer that flips to a confirmation a moment later reads as a control
    // that acted on its own.
    (window as unknown as { SDPIComponents: unknown }).SDPIComponents = undefined;

    const el = document.createElement("ird-enable-feature");

    el.setAttribute("feature", "race-engineer");
    document.body.appendChild(el);

    expect(el.textContent).toBe("");
  });

  it("renders nothing for a feature it was not taught", async () => {
    expect((await mount("not-a-feature")).textContent).toBe("");
  });

  it("stops listening once detached", async () => {
    const el = await mount("race-engineer");

    expect(handlers).toHaveLength(1);
    el.remove();
    expect(handlers).toHaveLength(0);
  });
});
