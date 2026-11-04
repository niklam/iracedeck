import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `dial-controller.ejs`, the controller resolution and view switch every dial
 * Property Inspector shares (#1329), run as a PI loads it; and the partials
 * themselves, none of which may carry a dial view (#1013). How the action
 * templates use them — which include the partial, and what a knob-shaped PI
 * compiles to — is held by `iracing-actions`' `src/pi-templates/dial-pi-knob-gating.test.ts`,
 * beside the templates (#1375).
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

describe("dial partials (#1013)", () => {
  it("finds no dial view inside a partial, which iracing-actions' template scan cannot see", () => {
    const withDialView = readdirSync(partialsDir)
      .filter((file) => file.endsWith(".ejs"))
      .filter((file) => readFileSync(path.join(partialsDir, file), "utf-8").includes('id="dial-settings"'));

    expect(withDialView).toEqual([]);
  });

  describe("the shared resolver and view switch behave as each local copy did (#1329)", () => {
    type ControllerWindow = {
      SDPIComponents?: { streamDeckClient?: { getConnectionInfo: () => Promise<unknown> } };
      irdResolveController?: () => Promise<"Encoder" | "Keypad" | null>;
      irdApplyDialView?: () => void;
    };

    type StubDocument = { getElementById: (id: string) => unknown; hidden: Map<string, boolean> };

    /** The three sections the view switch toggles, each with a `hidden` flag the stub classList writes. */
    function stubDocument(): StubDocument {
      const hidden = new Map([
        ["keypad-settings", false],
        ["keypad-appearance", false],
        ["dial-settings", true],
      ]);

      return {
        hidden,
        getElementById: (id: string) =>
          hidden.has(id)
            ? {
                classList: {
                  add: (c: string) => c === "hidden" && hidden.set(id, true),
                  remove: (c: string) => c === "hidden" && hidden.set(id, false),
                },
              }
            : null,
      };
    }

    /** Runs the partial's own `<script>` against a stub page, the way a PI loads it. */
    function loadPartial(win: ControllerWindow, doc: StubDocument = stubDocument()): ControllerWindow {
      // Without the EJS comment, whose prose names `<script>` itself.
      const source = readFileSync(path.join(partialsDir, "dial-controller.ejs"), "utf-8").replace(/<%#[\s\S]*?%>/g, "");
      const script = /<script>([\s\S]*?)<\/script>/.exec(source)?.[1];

      expect(script).toBeDefined();
      new Function("window", "document", script ?? "")(win, doc);

      return win;
    }

    function withController(controller: unknown): ControllerWindow {
      return {
        SDPIComponents: {
          streamDeckClient: { getConnectionInfo: async () => ({ actionInfo: { payload: { controller } } }) },
        },
      };
    }

    it.each([
      ["Encoder", "Encoder"],
      ["Knob", "Encoder"],
      ["Keypad", "Keypad"],
      ["Information", "Keypad"],
      [undefined, "Keypad"],
    ])("resolves a reported controller of %s to %s", async (controller, expected) => {
      expect(await loadPartial(withController(controller)).irdResolveController?.()).toBe(expected);
    });

    it("resolves a keypad when there is no sdpi client", async () => {
      expect(await loadPartial({}).irdResolveController?.()).toBe("Keypad");
    });

    it('resolves null when the lookup throws, which every `=== "Encoder"` caller keeps as the keypad view', async () => {
      const win = loadPartial({
        SDPIComponents: {
          streamDeckClient: {
            getConnectionInfo: async () => {
              throw new Error("host gone");
            },
          },
        },
      });

      expect(await win.irdResolveController?.()).toBeNull();
    });

    it("applies the dial view: hides both keypad sections and shows the dial's", () => {
      const doc = stubDocument();

      loadPartial({}, doc).irdApplyDialView?.();

      expect(Object.fromEntries(doc.hidden)).toEqual({
        "keypad-settings": true,
        "keypad-appearance": true,
        "dial-settings": false,
      });
    });
  });
});
