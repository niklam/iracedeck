/// <reference lib="dom" />
/**
 * Audio Test Button Web Component for Stream Deck Property Inspector
 *
 * A styled button that, when clicked, writes a timestamp into a hidden
 * per-action setting (an `sdpi-textfield`) so the action's
 * `onDidReceiveSettings` handler can detect the bump and trigger a
 * preview. Used by Pit Crew to call `playRadarTest()` without adding a
 * richer RPC surface.
 *
 * Usage in HTML:
 * ```html
 * <div style="display:none;">
 *   <sdpi-textfield id="test-radar-field" setting="_testRadarVolume"></sdpi-textfield>
 * </div>
 * <ird-audio-test target="test-radar-field" label="Test"></ird-audio-test>
 * ```
 *
 * Attributes:
 * - target: DOM id of the hidden `sdpi-textfield` whose value should be
 *   bumped to `Date.now()` on click.
 * - label: Button text (default "Test").
 * - preview: "radar" | "voice" | "background" — inside the dedicated settings
 *   window (#992) there is no action context, so the click instead sends
 *   `sendToPlugin { event: "audioPreview", kind }` and the plugin runs the
 *   preview directly.
 */
import { sendToPlugin } from "./sdpi-client.js";
import { inSettingsWindow } from "./settings-window-context.js";

let styleInjected = false;

export class AudioTest extends HTMLElement {
  private button: HTMLButtonElement | null = null;
  private _initialized = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.buildDOM();
    this.attachListeners();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-audio-test button {
        padding: 2px 10px;
        border: 1px solid #555;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        background: #2a2a2a;
        color: #808080;
        flex-shrink: 0;
        height: 26px;
        box-sizing: border-box;
      }
      ird-audio-test button:hover {
        color: #d8d8d8;
        border-color: #777;
      }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    const label = this.getAttribute("label") ?? "Test";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.textContent = label;
    this.appendChild(this.button);
  }

  private attachListeners(): void {
    this.button?.addEventListener("click", () => {
      // Settings window (#992): there is no action context, so a per-action
      // settings bump reaches nothing. Ask the plugin to run the preview
      // directly instead. `preview` names the kind ("radar"|"voice"|"background").
      if (inSettingsWindow()) {
        const kind = this.getAttribute("preview");

        if (kind) sendToPlugin({ event: "audioPreview", kind });

        return;
      }

      const targetId = this.getAttribute("target");

      if (!targetId) return;

      const field = document.getElementById(targetId) as HTMLInputElement | null;

      if (!field) return;

      field.value = String(Date.now());
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-audio-test")) {
    customElements.define("ird-audio-test", AudioTest);
  }
}
