/**
 * ird-black-box-caveat — explains, in the PI, why "Show black box" will do nothing.
 *
 * Showing a black box needs TWO keyboard bindings: the target box, and a
 * different box to prime the switch with (a black-box hotkey is a toggle, and
 * telemetry never reports which box is shown — see
 * `iracing-actions/src/shared/black-box.ts`). Both must be keyboard bindings:
 * a SimHub role goes over HTTP and cannot join the single atomic SendInput batch
 * that keeps the priming box from flickering, so the plugin skips the box
 * entirely rather than degrading. The value still changes either way.
 *
 * Rendered only when the feature checkbox is ticked AND the bindings can't do it.
 *
 * @example
 * <ird-black-box-caveat
 *   enabled-setting="showBlackBox"
 *   target="blackBoxFuel"
 *   candidates='["blackBoxLapTiming","blackBoxStandings"]'
 *   message="Showing the black box needs keyboard bindings…"
 * ></ird-black-box-caveat>
 */
import { parseKeyBinding } from "./key-binding-input.js";

/**
 * The feature checkbox is a per-action setting whose live value is only reliably
 * readable from the DOM (the same reason ird-binding-status polls). Global
 * binding values, by contrast, arrive on didReceiveGlobalSettings.
 */
const CHECKBOX_POLL_INTERVAL_MS = 250;

interface ValueElement extends Element {
  value?: unknown;
}

interface GlobalSettingsEvent {
  payload: { settings: Record<string, unknown> };
}

interface StreamDeckClient {
  getGlobalSettings(): Promise<Record<string, unknown>>;
  didReceiveGlobalSettings: { subscribe(fn: (ev: GlobalSettingsEvent) => void): unknown };
}

/** Escape a value for safe use inside a `[attr="…"]` selector. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function streamDeckClient(): StreamDeckClient | null {
  const sdpi = (window as unknown as { SDPIComponents?: { streamDeckClient?: StreamDeckClient } }).SDPIComponents;

  return sdpi?.streamDeckClient ?? null;
}

/**
 * Whether a stored global binding value is a usable KEYBOARD binding.
 * A SimHub role, an empty value, or a corrupt one all return false.
 */
export function isKeyboardBinding(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;

  try {
    const parsed = JSON.parse(raw) as { type?: string };

    if (parsed.type === "simhub") return false;
  } catch {
    // Not JSON — fall through; parseKeyBinding rejects it below.
  }

  return parseKeyBinding(raw) !== null;
}

export class BlackBoxCaveat extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private settings: Record<string, unknown> = {};
  private settingsLoaded = false;
  private pollTimer: number | null = null;
  private initialized = false;
  private readonly onDomChange = (): void => this.render();

  connectedCallback(): void {
    if (this.initialized) return;

    this.initialized = true;
    this.container = document.createElement("div");
    this.container.className = "ird-supporting-text";
    this.container.style.display = "none";
    this.appendChild(this.container);

    const client = streamDeckClient();

    if (client) {
      void client.getGlobalSettings().then((settings) => {
        this.settings = settings ?? {};
        this.settingsLoaded = true;
        this.render();
      });

      client.didReceiveGlobalSettings.subscribe((ev) => {
        this.settings = ev?.payload?.settings ?? {};
        this.settingsLoaded = true;
        this.render();
      });
    }

    document.addEventListener("change", this.onDomChange);
    document.addEventListener("input", this.onDomChange);
    this.pollTimer = window.setInterval(this.onDomChange, CHECKBOX_POLL_INTERVAL_MS);

    this.render();
  }

  disconnectedCallback(): void {
    document.removeEventListener("change", this.onDomChange);
    document.removeEventListener("input", this.onDomChange);

    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Read the feature checkbox's live value from the DOM. */
  private isEnabled(): boolean {
    const setting = this.getAttribute("enabled-setting");

    if (!setting) return false;

    const el = document.querySelector(`[setting="${cssAttr(setting)}"]`) as ValueElement | null;

    if (!el) return false;

    return el.value === true || el.value === "true";
  }

  private parseCandidates(): string[] {
    const raw = this.getAttribute("candidates");

    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw) as unknown;

      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  /** True when the bindings as configured cannot show the box. */
  private bindingsUnusable(): boolean {
    const target = this.getAttribute("target");

    if (!target) return false;

    if (!isKeyboardBinding(this.settings[target])) return true;

    // A prime is any OTHER keyboard-bound box.
    return !this.parseCandidates().some((key) => key !== target && isKeyboardBinding(this.settings[key]));
  }

  private render(): void {
    if (!this.container) return;

    // Never flash the caveat before the first global-settings delivery.
    const show = this.settingsLoaded && this.isEnabled() && this.bindingsUnusable();

    if (!show) {
      this.container.style.display = "none";
      this.container.textContent = "";

      return;
    }

    this.container.textContent = this.getAttribute("message") ?? "";
    this.container.style.display = "";
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-black-box-caveat")) {
  customElements.define("ird-black-box-caveat", BlackBoxCaveat);
}
