/// <reference lib="dom" />
/**
 * Binding / communication status line (issue #612).
 *
 * Rendered directly under an action's Mode selector. For the currently
 * selected mode it states how that mode talks to iRacing (iRacing API, key
 * binding, or chat command) and — for key-binding modes — whether a binding is
 * configured (keyboard OR SimHub role), with a link that opens the global
 * key-bindings accordion. Updates live as the mode changes and as bindings are
 * set / cleared / switched between keyboard and SimHub.
 *
 * Usage in a PI template (the comms map is emitted from action-comms.json):
 * ```html
 * <ird-binding-status
 *   mode-setting="mode"
 *   comms='<%- JSON.stringify(require("./data/action-comms.json")["fuel-service"]) %>'
 * ></ird-binding-status>
 * ```
 *
 * Attributes:
 * - comms        — JSON ActionCommMap: mode value → { method, binding? }
 * - mode-setting — name of the primary mode setting (default "mode")
 * - default-mode — mode value to use when there is no mode setting (single-mode actions)
 *
 * SYNC NOTE: CommDescriptor / BindingKeyRef below mirror their authoritative
 * counterparts in @iracedeck/deck-core/comm-descriptor.ts. The PI runs in a
 * browser and cannot import from deck-core (Node.js). When the descriptor
 * shape changes, update BOTH locations.
 */
import { formatKeyBinding, parseKeyBinding } from "./key-binding-utils.js";
import { fetchSimHubReachable, SIMHUB_POLL_INTERVAL_MS } from "./simhub-probe.js";

type CommMethod = "api" | "keybind" | "chat";

interface BindingKeyConstant {
  scope: "global" | "action";
  key: string;
}
interface BindingKeyMulti {
  scope: "global" | "action";
  keys: string[];
}
interface BindingKeyResolved {
  scope: "global" | "action";
  keyBy: { setting: string; map: Record<string, string> };
}
type BindingKeyRef = BindingKeyConstant | BindingKeyMulti | BindingKeyResolved;

interface CommDescriptor {
  method: CommMethod;
  binding?: BindingKeyRef;
}
type ActionCommMap = Record<string, CommDescriptor>;

/** Accordion that holds the global key bindings (see global-key-bindings.ejs). */
const KEY_BINDINGS_ACCORDION_ID = "Related Key Bindings";

/**
 * Poll interval for reading current values off the PI's DOM controls. The
 * Stream Deck settings-subscription APIs do not reliably re-deliver changes to
 * a read-only observer like this; the proven approach in this codebase
 * (conditional-visibility) reads the control's `.value` with change/input
 * events plus a polling fallback, because sdpi-select events can be unreliable.
 */
const DOM_POLL_INTERVAL_MS = 250;

/** An element that carries a current value (sdpi-select / ird-key-binding / inputs). */
interface ValueElement extends Element {
  value?: unknown;
}

/** Escape a value for safe use inside a `[attr="…"]` selector. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function readValue(selector: string): string | null {
  const el = document.querySelector(selector) as ValueElement | null;

  if (!el) return null;

  const v = el.value;

  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function isConstantKey(ref: BindingKeyRef): ref is BindingKeyConstant {
  return "key" in ref;
}

function isMultiKey(ref: BindingKeyRef): ref is BindingKeyMulti {
  return "keys" in ref;
}

/** Parse a stored binding global-setting value into a display-ready shape. */
function parseStoredBinding(
  value: string,
): { kind: "keyboard"; text: string } | { kind: "simhub"; role: string } | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as { type?: string; role?: string };

    if (parsed.type === "simhub" && typeof parsed.role === "string" && parsed.role.length > 0) {
      return { kind: "simhub", role: parsed.role };
    }
  } catch {
    return null;
  }

  const kb = parseKeyBinding(value);

  return kb ? { kind: "keyboard", text: formatKeyBinding(kb) } : null;
}

let styleInjected = false;

export class BindingStatus extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private comms: ActionCommMap = {};
  private currentMode = "";
  /** Live values of secondary (keyBy) settings, by setting name. */
  private secondary = new Map<string, string>();
  /** Live binding values, by global-settings key. */
  private bindings = new Map<string, string>();
  /** Global keys whose value has arrived at least once (distinguishes "loading" from "unset"). */
  private loadedBindings = new Set<string>();
  /** Secondary settings whose value has arrived at least once. */
  private loadedSecondary = new Set<string>();
  private initialized = false;

  // SimHub reachability is polled live (browser-side) while a SimHub-bound mode
  // is shown, so the "SimHub not connected" warning clears as soon as SimHub
  // comes up — no plugin-maintained setting needed (#612).
  private simHubHost = "127.0.0.1";
  private simHubPort = 8888;
  private simHubProbed = false;
  private simHubReachable = false;
  private simHubPollTimer: number | null = null;
  /** Recomputed each render: does the current display depend on SimHub being up? */
  private pollSimHub = false;

  /** Name of the action setting whose value is the mode. */
  private modeSetting = "mode";
  /** Secondary (keyBy) action-setting names referenced by this action's modes. */
  private secondaryNames: string[] = [];
  /** Every global binding key referenced by this action's modes. */
  private candidateKeys: string[] = [];
  /** DOM polling fallback + a bound change/input handler for snappy updates. */
  private domPollTimer: number | null = null;
  private readonly onDomChange = (): void => this.readDom();

  connectedCallback(): void {
    if (this.initialized) return;

    this.initialized = true;
    this.injectStyle();
    this.container = document.createElement("div");
    this.container.className = "ird-binding-status";
    this.appendChild(this.container);

    this.comms = this.parseComms(this.getAttribute("comms"));
    this.currentMode = this.getAttribute("default-mode") ?? "";
    this.hookSettings();
    this.render();
  }

  private parseComms(raw: string | null): ActionCommMap {
    if (!raw) return {};

    try {
      const parsed: unknown = JSON.parse(raw);

      return parsed && typeof parsed === "object" ? (parsed as ActionCommMap) : {};
    } catch {
      return {};
    }
  }

  private hookSettings(): void {
    this.modeSetting = this.getAttribute("mode-setting") || "mode";

    // Collect the secondary (keyBy) setting names and the candidate binding keys.
    const secondaryNames = new Set<string>();
    const bindingKeys = new Set<string>();

    for (const descriptor of Object.values(this.comms)) {
      const ref = descriptor.binding;

      if (!ref) continue;

      if (isConstantKey(ref)) {
        bindingKeys.add(ref.key);
      } else if (isMultiKey(ref)) {
        for (const key of ref.keys) bindingKeys.add(key);
      } else {
        secondaryNames.add(ref.keyBy.setting);

        for (const key of Object.values(ref.keyBy.map)) bindingKeys.add(key);
      }
    }

    this.secondaryNames = [...secondaryNames];
    this.candidateKeys = [...bindingKeys];

    // Read current values straight off the PI's DOM controls — the Mode
    // <sdpi-select>, any secondary <sdpi-select>, and the <ird-key-binding>
    // inputs in the key-bindings accordion (which hold the live binding value
    // and update on edit). change/input events make it snappy; a polling
    // fallback covers controls whose events are unreliable (and catches binding
    // edits in the accordion). This is the proven pattern in this codebase.
    document.addEventListener("input", this.onDomChange, true);
    document.addEventListener("change", this.onDomChange, true);
    this.domPollTimer = window.setInterval(this.onDomChange, DOM_POLL_INTERVAL_MS);

    this.readDom();
  }

  /** Read the current mode, secondary values, and binding values from the DOM. */
  private readDom(): void {
    let changed = false;

    // Mode (sdpi-select) — fall back to the default-mode attribute when empty.
    const rawMode = readValue(`[setting="${cssAttr(this.modeSetting)}"]`);
    const mode = rawMode || (this.getAttribute("default-mode") ?? "");

    if (mode !== this.currentMode) {
      this.currentMode = mode;
      changed = true;
    }

    // Secondary (keyBy) settings.
    for (const name of this.secondaryNames) {
      const value = readValue(`[setting="${cssAttr(name)}"]`);

      if (value === null) continue; // control not present yet

      this.loadedSecondary.add(name);

      if (this.secondary.get(name) !== value) {
        this.secondary.set(name, value);
        changed = true;
      }
    }

    // Binding values — read from the ird-key-binding inputs (live source).
    for (const key of this.candidateKeys) {
      const value = readValue(`ird-key-binding[setting="${cssAttr(key)}"]`);

      if (value === null) continue; // input not in this PI / not yet rendered

      this.loadedBindings.add(key);

      if (this.bindings.get(key) !== value) {
        this.bindings.set(key, value);
        changed = true;
      }
    }

    // SimHub host/port (if those inputs exist on this PI) for the reachability probe.
    const host = readValue(`[setting="simHubHost"]`) || "127.0.0.1";
    const port = parseInt(readValue(`[setting="simHubPort"]`) ?? "", 10) || 8888;

    if (host !== this.simHubHost || port !== this.simHubPort) {
      this.simHubHost = host;
      this.simHubPort = port;
      this.simHubProbed = false;

      if (this.simHubPollTimer !== null) void this.probeSimHub();

      changed = true;
    }

    if (changed) this.render();
  }

  /** Resolve ALL binding keys required by the current mode. */
  private resolveKeys(ref: BindingKeyRef): string[] {
    if (isConstantKey(ref)) return [ref.key];

    if (isMultiKey(ref)) return ref.keys;

    const secondaryValue = this.secondary.get(ref.keyBy.setting);
    const key = secondaryValue ? ref.keyBy.map[secondaryValue] : undefined;

    return key ? [key] : [];
  }

  private render(): void {
    if (!this.container) return;

    this.pollSimHub = false;
    const rows = this.buildRows();
    this.container.replaceChildren(...(rows === "pending" ? [] : rows));

    // Poll SimHub only while a SimHub-bound mode is shown.
    if (this.pollSimHub) this.ensureSimHubPolling();
    else this.stopSimHubPolling();
  }

  /** Build the status rows for the current state, or "pending" to show nothing yet. */
  private buildRows(): HTMLDivElement[] | "pending" {
    const descriptor = this.comms[this.currentMode];

    if (!descriptor) return [];

    if (descriptor.method === "api") return [this.line("ok", "✓", "iRacing API")];

    if (descriptor.method === "chat") return [this.line("ok", "✓", "Chat command")];

    // keybind with no binding ref → fixed key (e.g. Escape) or plugin-internal:
    // no user setup needed, never warns.
    const ref = descriptor.binding;

    if (!ref) return [this.line("ok", "✓", "No binding needed.")];

    // A keyBy reference can't be resolved until its secondary setting has
    // loaded — render nothing rather than flash "No binding set" on PI open.
    if (!isConstantKey(ref) && !isMultiKey(ref) && !this.loadedSecondary.has(ref.keyBy.setting)) {
      return "pending";
    }

    const keys = this.resolveKeys(ref);

    // Secondary value is loaded but unmapped → genuinely no binding.
    if (keys.length === 0) return [this.missingRow()];

    // Wait for every required key's value to arrive before judging set/unset.
    if (keys.some((k) => !this.loadedBindings.has(k))) return "pending";

    const parsed = keys.map((k) => parseStoredBinding(this.bindings.get(k) ?? ""));

    // Warn if ANY required key is unset (multi-key modes need all of them).
    if (parsed.some((p) => p === null)) return [this.missingRow()];

    const set = parsed as Array<{ kind: "keyboard"; text: string } | { kind: "simhub"; role: string }>;

    // Single SimHub role.
    if (set.length === 1 && set[0].kind === "simhub") {
      this.pollSimHub = true;

      return this.simHubRows(set[0].role);
    }

    const labels = set.map((p) => (p.kind === "keyboard" ? p.text : `SimHub: ${p.role}`));
    const rows = [this.line("ok", "✓", `Key binding: ${labels.join(", ")}`)];

    // A SimHub key among several carries the not-connected warning too.
    if (set.some((p) => p.kind === "simhub")) {
      this.pollSimHub = true;
      const warn = this.simHubNotConnectedRow();

      if (warn) rows.push(warn);
    }

    return rows;
  }

  private missingRow(): HTMLDivElement {
    const row = this.line("warn", "⚠", "No binding set — ");
    const link = document.createElement("a");
    link.href = "#";
    link.className = "ird-binding-status-link";
    link.textContent = "set it here";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      this.openKeyBindings();
    });
    row.querySelector(".ird-binding-status-text")!.appendChild(link);

    return row;
  }

  private simHubRows(role: string): HTMLDivElement[] {
    const rows = [this.line("ok", "✓", `SimHub binding: ${role}`)];
    const warn = this.simHubNotConnectedRow();

    if (warn) rows.push(warn);

    return rows;
  }

  /** Red "SimHub not connected" line, only once a probe has confirmed it's down. */
  private simHubNotConnectedRow(): HTMLDivElement | null {
    return this.simHubProbed && !this.simHubReachable ? this.line("danger", "✗", "SimHub not connected") : null;
  }

  // --- SimHub reachability polling ---

  private ensureSimHubPolling(): void {
    if (this.simHubPollTimer !== null) return;

    void this.probeSimHub();
    this.simHubPollTimer = window.setInterval(() => void this.probeSimHub(), SIMHUB_POLL_INTERVAL_MS);
  }

  private stopSimHubPolling(): void {
    if (this.simHubPollTimer !== null) {
      window.clearInterval(this.simHubPollTimer);
      this.simHubPollTimer = null;
    }
  }

  private async probeSimHub(): Promise<void> {
    const reachable = await fetchSimHubReachable(this.simHubHost, this.simHubPort);
    this.simHubProbed = true;

    if (reachable !== this.simHubReachable) {
      this.simHubReachable = reachable;
    }

    // Re-render so the not-connected line appears/clears (also on first probe).
    this.render();
  }

  disconnectedCallback(): void {
    this.stopSimHubPolling();
    document.removeEventListener("input", this.onDomChange, true);
    document.removeEventListener("change", this.onDomChange, true);

    if (this.domPollTimer !== null) {
      window.clearInterval(this.domPollTimer);
      this.domPollTimer = null;
    }
  }

  private line(level: "ok" | "warn" | "muted" | "danger", symbol: string, text: string): HTMLDivElement {
    const row = document.createElement("div");
    row.className = `ird-binding-status-line ird-binding-status-${level}`;

    if (symbol) {
      const icon = document.createElement("span");
      icon.className = "ird-binding-status-icon";
      icon.textContent = symbol;
      row.appendChild(icon);
    }

    const span = document.createElement("span");
    span.className = "ird-binding-status-text";
    span.textContent = text;
    row.appendChild(span);

    return row;
  }

  /** Open the global key-bindings accordion and scroll it into view. */
  private openKeyBindings(): void {
    const selector = `details[data-accordion-id="${KEY_BINDINGS_ACCORDION_ID}"]`;
    const accordion = document.querySelector(selector) as HTMLDetailsElement | null;

    if (!accordion) return;

    // Setting `open` fires a toggle event, which the accordion persistence
    // listener picks up — no need to write _accordionState here.
    accordion.open = true;
    accordion.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-binding-status { display: block; }
      ird-binding-status .ird-binding-status-line {
        display: flex;
        gap: 6px;
        align-items: baseline;
        margin: 4px 0 4px 95px;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif,
                     "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        font-size: 8pt;
        line-height: 1.3;
      }
      ird-binding-status .ird-binding-status-icon { flex-shrink: 0; }
      ird-binding-status .ird-binding-status-ok { color: #5dd17a; }
      ird-binding-status .ird-binding-status-warn { color: #ffc04d; }
      ird-binding-status .ird-binding-status-danger { color: #ff5c5c; }
      ird-binding-status .ird-binding-status-muted { color: #9aa4ad; }
      ird-binding-status .ird-binding-status-link { color: #4aa3ff; cursor: pointer; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-binding-status")) {
    customElements.define("ird-binding-status", BindingStatus);
  }
}
