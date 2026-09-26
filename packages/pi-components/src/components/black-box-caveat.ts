/**
 * ird-black-box-caveat — explains, in the PI, what "Show black box" can do with
 * the bindings as configured.
 *
 * Showing a black box needs two bindings: the target box, and a different box
 * to prime the switch with (a black-box hotkey is a toggle, and telemetry never
 * reports which box is shown — see `iracing-actions/src/shared/black-box.ts`).
 * The runtime primes keyboard-first: when the target and some other box are
 * both keyboard-bound, the two presses go out as one atomic SendInput batch and
 * the priming box never renders. A SimHub role goes over HTTP and cannot join
 * that batch, so when one is involved the presses are sent one after the other
 * and the priming box may flash briefly (#962). This component mirrors that
 * decision, with one of three outcomes (checkbox ticked):
 *
 * | Bindings                                                        | Line shown        |
 * | --------------------------------------------------------------- | ----------------- |
 * | target unbound, or no other box bound at all                    | `message` (warning) |
 * | target a SimHub role, or no other box keyboard-bound but one is a SimHub role | `simhub-message` (info) |
 * | target and at least one other box keyboard-bound                | nothing           |
 *
 * The value still changes in every case. Nothing renders while the checkbox is
 * unticked or before the first global-settings delivery.
 *
 * @example
 * <ird-black-box-caveat
 *   enabled-setting="showBlackBox"
 *   target="blackBoxFuel"
 *   candidates='["blackBoxLapTiming","blackBoxStandings"]'
 *   message="Showing the black box needs black-box bindings…"
 *   simhub-message="…bound to a SimHub role, so the priming box may flash briefly…"
 * ></ird-black-box-caveat>
 */
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

type GlobalSettingsHandler = (ev: GlobalSettingsEvent) => void;

/**
 * sdpi-components' event object. `subscribe` returns nothing — it pushes the
 * handler onto an internal list — so detaching means calling `unsubscribe` with
 * the SAME function reference, not disposing a returned handle.
 */
interface StreamDeckClient {
  getGlobalSettings(): Promise<Record<string, unknown>>;
  didReceiveGlobalSettings: {
    subscribe(fn: GlobalSettingsHandler): void;
    unsubscribe?(fn: GlobalSettingsHandler): void;
  };
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
 * A stored global binding value as an object. The value is usually a JSON
 * string, but — like deck-core's runtime `parseBinding` — an already-parsed
 * object is accepted too. Anything else (empty, corrupt, a JSON scalar or
 * array) returns null.
 */
function bindingObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;

  if (typeof raw === "string") {
    if (raw.length === 0) return null;

    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a stored global binding value (a JSON string or an already-parsed
 * object) is a usable KEYBOARD binding — the shape deck-core's
 * `KeyBindingValueSchema` accepts, so the caveat and the runtime agree: `type`
 * absent or "keyboard", a non-empty `key`, and `modifiers` absent or an array of
 * strings. A SimHub role, an empty value, or a corrupt one all return false.
 */
export function isKeyboardBinding(raw: unknown): boolean {
  const binding = bindingObject(raw);

  if (!binding) return false;

  if (binding.type !== undefined && binding.type !== "keyboard") return false;

  if (typeof binding.key !== "string" || binding.key.length === 0) return false;

  const { modifiers } = binding;

  return modifiers === undefined || (Array.isArray(modifiers) && modifiers.every((m) => typeof m === "string"));
}

/**
 * Whether a stored global binding value (a JSON string or an already-parsed
 * object) is a usable SIMHUB role binding — `{ type: "simhub", role }` with a
 * non-empty role, the same shape the runtime's `SimHubBindingValueSchema`
 * accepts. A keyboard binding, an empty value, or a corrupt one all return false.
 */
export function isSimHubBinding(raw: unknown): boolean {
  const binding = bindingObject(raw);

  return binding?.type === "simhub" && typeof binding.role === "string" && binding.role.length > 0;
}

/**
 * What the caveat shows: the warning (the box can't be shown), the SimHub info
 * line (it can, but the priming box may flash), or nothing.
 */
type CaveatState = "warning" | "simhub-info" | "none";

let styleInjected = false;

/**
 * The warning is tinted with the same amber `ird-binding-status` uses for its
 * warnings, so it reads differently from the neutral info line; both keep the
 * shared `.ird-supporting-text` layout.
 */
function injectStyles(): void {
  if (styleInjected || typeof document === "undefined") return;

  const style = document.createElement("style");
  style.textContent = `
    ird-black-box-caveat .ird-black-box-caveat-warning { color: #ffc04d; }
  `;
  document.head.appendChild(style);
  styleInjected = true;
}

export class BlackBoxCaveat extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private settings: Record<string, unknown> = {};
  private settingsLoaded = false;
  private pollTimer: number | null = null;
  private connected = false;
  private readonly onDomChange = (): void => this.render();

  // On hosts that retain navigated-away PI pages (the #903 leak scenario),
  // disconnectedCallback never fires — pagehide is the only teardown signal,
  // so the poll stops there and resumes on pageshow.
  private pageHidden = false;
  private readonly onPageHide = (): void => {
    this.pageHidden = true;
    this.stopPolling();
  };
  private readonly onPageShow = (): void => {
    this.pageHidden = false;

    if (this.connected) this.startPolling();
  };
  private readonly onGlobalSettings: GlobalSettingsHandler = (ev) => {
    this.settings = ev?.payload?.settings ?? {};
    this.settingsLoaded = true;
    this.render();
  };

  connectedCallback(): void {
    if (this.connected) return;

    this.connected = true;
    this.container = document.createElement("div");
    this.container.className = "ird-supporting-text";
    injectStyles();
    this.container.style.display = "none";
    this.appendChild(this.container);

    const client = streamDeckClient();

    if (client) {
      void client.getGlobalSettings().then((settings) => {
        // A late resolve after disconnect must not resurrect a detached element.
        if (!this.connected) return;

        this.settings = settings ?? {};
        this.settingsLoaded = true;
        this.render();
      });

      client.didReceiveGlobalSettings.subscribe(this.onGlobalSettings);
    }

    document.addEventListener("change", this.onDomChange);
    document.addEventListener("input", this.onDomChange);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    // A reconnect may have missed pageshow while detached (its listener was
    // removed on disconnect). Script re-adding this element means the document
    // is live, so clear any stale hidden-page state before polling.
    this.pageHidden = false;
    this.startPolling();

    this.render();
  }

  private startPolling(): void {
    if (this.pageHidden || this.pollTimer !== null) return;

    this.pollTimer = window.setInterval(this.onDomChange, CHECKBOX_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Fully tear down, so a remove-then-re-add of this element (a PI re-rendering
   * the section) wires everything up again instead of leaving an inert husk.
   */
  disconnectedCallback(): void {
    this.connected = false;

    document.removeEventListener("change", this.onDomChange);
    document.removeEventListener("input", this.onDomChange);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);

    // sdpi's subscribe() returns nothing; detaching means passing the same
    // handler back to unsubscribe(). Optional — a stub may not implement it.
    streamDeckClient()?.didReceiveGlobalSettings.unsubscribe?.(this.onGlobalSettings);

    this.stopPolling();

    this.container?.remove();
    this.container = null;
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

  /**
   * Mirror the runtime's path choice for the bindings as configured. A prime is
   * any OTHER bound box, keyboard-bound ones preferred; the presses stay atomic
   * only when both the target and that prime are keyboard-bound.
   */
  private state(): CaveatState {
    const target = this.getAttribute("target");

    if (!target) return "none";

    const targetKeyboard = isKeyboardBinding(this.settings[target]);

    if (!targetKeyboard && !isSimHubBinding(this.settings[target])) return "warning";

    const others = this.parseCandidates()
      .filter((key) => key !== target)
      .map((key) => this.settings[key]);
    const keyboardPrime = others.some(isKeyboardBinding);

    if (!keyboardPrime && !others.some(isSimHubBinding)) return "warning";

    return targetKeyboard && keyboardPrime ? "none" : "simhub-info";
  }

  private render(): void {
    if (!this.container) return;

    // Never flash the caveat before the first global-settings delivery.
    const state: CaveatState = this.settingsLoaded && this.isEnabled() ? this.state() : "none";
    const warning = state === "warning";

    this.container.classList.toggle("ird-black-box-caveat-warning", warning);
    this.container.classList.toggle("ird-black-box-caveat-info", state === "simhub-info");

    if (state === "none") {
      this.container.style.display = "none";
      this.container.textContent = "";

      return;
    }

    this.container.textContent = this.getAttribute(warning ? "message" : "simhub-message") ?? "";
    this.container.style.display = "";
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-black-box-caveat")) {
  customElements.define("ird-black-box-caveat", BlackBoxCaveat);
}
