// @vitest-environment jsdom
import ejs from "ejs";
import path from "node:path";
import url from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/adjust-style.ejs` and runs its own `<script>`
 * against the rendered markup. Since #1453 the partial takes a mode made of
 * several selects (Audio Controls' Mode + Action, joined with "-") and a
 * `noValueModes` list that shows a note; the setup actions' single-select
 * include must behave as before.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

function render(params: Record<string, unknown>): string {
  return ejs.render(
    "<%- include('adjust-style', params) %>",
    { params },
    {
      views: [partialsDir],
      filename: path.join(partialsDir, "_test.ejs"),
    },
  );
}

/** A stand-in sdpi-select: the partial reads `.value`, falling back to the `default` attribute. */
class FakeSdpiSelect extends HTMLElement {
  value = "";
}

let polls: (() => void)[] = [];

beforeAll(() => {
  customElements.define("sdpi-select", FakeSdpiSelect);
});

beforeEach(() => {
  polls = [];
  (window as unknown as { irdPoll: (fn: () => void) => void }).irdPoll = (fn) => polls.push(fn);
  document.body.innerHTML = "";
});

/** Puts the mode selects and the rendered partial on the page, then runs the partial's script. */
async function mount(params: Record<string, unknown>, modeSelects: Record<string, string>): Promise<void> {
  const html = render(params);
  const selects = Object.entries(modeSelects)
    .map(([id, def]) => `<sdpi-select id="${id}" default="${def}"></sdpi-select>`)
    .join("");
  document.body.innerHTML = selects + html.replace(/<script>[\s\S]*?<\/script>/, "");

  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script).toBeDefined();
  new Function(script ?? "")();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(id: string, value: string): void {
  (document.getElementById(id) as FakeSdpiSelect).value = value;

  for (const poll of polls) poll();
}

const shown = (id: string) => !document.getElementById(id)?.classList.contains("hidden");

const AUDIO_PARAMS = {
  modeSelectId: ["category-select", "action-select"],
  pairedModes: ["master-volume-up", "master-volume-down", "race-engineer-volume-up", "race-engineer-volume-down"],
  noValueModes: ["master-volume-up", "master-volume-down"],
  helpText: "Volume help.",
};

describe("adjust-style.ejs", () => {
  describe("a single mode select (the setup actions' include)", () => {
    const SETUP_PARAMS = {
      modeSelectId: "setting-select",
      pairedModes: ["engine-power"],
      viewModes: ["view-engine-power"],
    };

    it("renders the default help text and no shown note", async () => {
      await mount(SETUP_PARAMS, { "setting-select": "engine-power" });

      expect(document.getElementById("adjust-style-help")?.textContent).toContain(
        "three with a View key in the middle",
      );
      expect(shown("adjust-style-item")).toBe(true);
      expect(shown("adjust-view-style-item")).toBe(false);
      expect(shown("adjust-style-no-value-note")).toBe(false);
    });

    it("switches to the Display Style select on a View mode", async () => {
      await mount(SETUP_PARAMS, { "setting-select": "engine-power" });
      setValue("setting-select", "view-engine-power");

      expect(shown("adjust-style-item")).toBe(false);
      expect(shown("adjust-view-style-item")).toBe(true);
    });
  });

  describe("a mode made of several selects (#1453)", () => {
    it("matches on the values joined with '-'", async () => {
      await mount(AUDIO_PARAMS, { "category-select": "race-engineer", "action-select": "volume-up" });

      expect(shown("adjust-style-item")).toBe(true);
      expect(document.getElementById("adjust-style-help")?.textContent?.trim()).toBe("Volume help.");
    });

    it("hides the style rows on a pair that is not listed", async () => {
      await mount(AUDIO_PARAMS, { "category-select": "push-to-talk", "action-select": "volume-up" });

      expect(shown("adjust-style-item")).toBe(false);
      expect(shown("adjust-style-help")).toBe(false);
      expect(shown("adjust-style-no-value-note")).toBe(false);
    });

    it("follows a change of either select", async () => {
      await mount(AUDIO_PARAMS, { "category-select": "push-to-talk", "action-select": "volume-up" });

      setValue("category-select", "master");
      expect(shown("adjust-style-item")).toBe(true);

      setValue("action-select", "mute");
      expect(shown("adjust-style-item")).toBe(false);
    });

    it("shows the no-value note on a no-value mode only", async () => {
      await mount(AUDIO_PARAMS, { "category-select": "master", "action-select": "volume-down" });

      expect(shown("adjust-style-no-value-note")).toBe(true);
      expect(document.getElementById("adjust-style-no-value-note")?.textContent).toContain(
        "Split as Big +/−, Edge chevrons as Big chevrons, Joined pill as Pill end",
      );

      setValue("category-select", "race-engineer");
      expect(shown("adjust-style-no-value-note")).toBe(false);
    });

    it("shows Position in Pair for a position-aware style", async () => {
      await mount(AUDIO_PARAMS, { "category-select": "master", "action-select": "volume-up" });
      expect(shown("adjust-position-item")).toBe(false);

      setValue("adjust-style-select", "joined-pill");
      expect(shown("adjust-position-item")).toBe(true);
    });
  });
});
