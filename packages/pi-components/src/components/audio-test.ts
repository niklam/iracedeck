/// <reference lib="dom" />
/**
 * Audio Test Button Web Component
 *
 * A styled button that asks the plugin to play a short audio preview, so the
 * user can hear a voice or volume setting without going on track.
 *
 * It lives on the settings window, which owns the Race Engineer audio settings.
 * There is no action context there, so the click sends
 * `sendToPlugin { event: "audioPreview", kind }` and the plugin runs the preview
 * itself (`runAudioPreview`). Until #1003 the same button also appeared in the
 * Pit Crew Property Inspector and took a second route — bumping a hidden
 * `_test*` timestamp setting that the action watched. That route went with the
 * controls it served.
 *
 * Usage in HTML:
 * ```html
 * <ird-audio-test preview="radar" label="Test"></ird-audio-test>
 * ```
 *
 * Attributes:
 * - preview: "radar" | "voice" | "background" — which preview to play. Without
 *   it the button is inert.
 * - label: Button text (default "Test").
 */
import { sendToPlugin } from "./sdpi-client.js";

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
      const kind = this.getAttribute("preview");

      if (kind) sendToPlugin({ event: "audioPreview", kind });
    });
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-audio-test")) {
    customElements.define("ird-audio-test", AudioTest);
  }
}
