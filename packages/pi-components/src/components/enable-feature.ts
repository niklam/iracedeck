/**
 * `<ird-enable-feature feature="…">` — a one-press opt-in on the Getting Started
 * page (issue #1061).
 *
 * STATE-DRIVEN, not fire-and-forget. It reads the setting it would change and
 * renders either the offer or a confirmation, so "pressed twice" is not a case
 * that exists and somebody who enabled the feature elsewhere sees the truth
 * rather than a button implying otherwise. Same discipline as `ird-warnings`:
 * the control describes a state, it does not latch.
 *
 * It reads settings exactly TWICE: once on connect, and again whenever the
 * plugin pushes `didReceiveGlobalSettings`. It must NEVER re-read in response
 * to a DOM event, however tempting — a document-scoped `change` listener that
 * called `getGlobalSettings()` shipped briefly and broke every control on the
 * page. In sdpi a read is not addressed to the requester: the reply replaces
 * the shared settings snapshot wholesale and every `global` control re-renders
 * from it, while writes are debounced 250 ms — so a read fired on `change`
 * lands inside the window before the write is even sent, and repaints the page
 * from a snapshot that does not contain the user's change.
 *
 * The cost of that restriction is known and accepted: the fake host does not
 * echo a write back to the socket that sent it (#992), so a sibling control on
 * another tab flipping the same key leaves this one showing a stale offer until
 * the next push. Pressing it then is idempotent. Reading the sibling's DOM
 * value instead is the shape `ird-binding-status` uses, but it needs that
 * component's polling and empty-`.value` handling to be correct — more than a
 * one-line change, and it fails silently when wrong.
 *
 * It never writes settings itself. The press sends one `sendToPlugin` frame and
 * the plugin decides what that means — which matters for the Race Engineer,
 * whose opt-in has to write its gate AND its startup policy together or it
 * silently reverts on the next start for every pre-#1007 install. That
 * invariant belongs in TypeScript beside the gate table it depends on
 * (`enableFeatureWrites` in deck-core), not in two independent controls here.
 */
import { sendToPlugin } from "./sdpi-client.js";

type GlobalSettingsHandler = (ev: { payload?: { settings?: Record<string, unknown> } }) => void;

interface StreamDeckClient {
  getGlobalSettings(): Promise<Record<string, unknown>>;
  didReceiveGlobalSettings: {
    subscribe(fn: GlobalSettingsHandler): void;
    unsubscribe?(fn: GlobalSettingsHandler): void;
  };
}

function streamDeckClient(): StreamDeckClient | null {
  const sdpi = (window as unknown as { SDPIComponents?: { streamDeckClient?: StreamDeckClient } }).SDPIComponents;

  return sdpi?.streamDeckClient ?? null;
}

interface FeatureCopy {
  /** Global-settings key whose value decides which face the control shows. */
  readonly key: string;
  /** Whether the stored value counts as "already on". */
  readonly isOn: (value: unknown) => boolean;
  /** Label on the offer. */
  readonly action: string;
  /** Shown instead of the button once it is on. */
  readonly done: string;
  /**
   * When true the control renders NOTHING while the feature is already on,
   * rather than a confirmation — for a suggestion that is only ever advice
   * about a setting the user probably wants, not a step in the page.
   */
  readonly hideWhenOn?: boolean;
}

/** @internal Exported for testing. */
export const ENABLE_FEATURE_COPY: Readonly<Record<string, FeatureCopy>> = Object.freeze({
  "race-engineer": {
    key: "pitCrewRaceEngineerEnabled",
    isOn: (value) => value === true || value === "true",
    action: "Turn on the Race Engineer",
    done: "The Race Engineer is on. You will hear a radio check the next time iRacing starts.",
  },
  "changelog-updates": {
    key: "changelogNotification",
    // Anything other than "never" already opens the notes at some cadence, so
    // the offer would be a lie. `undefined` means the store has not loaded yet;
    // treat that as off rather than flashing a confirmation that may be wrong.
    isOn: (value) => typeof value === "string" && value !== "" && value !== "never",
    action: "I want to read about new features",
    done: "You will see what changed after an update.",
  },
  "focus-iracing-window": {
    key: "focusIRacingWindow",
    // Absent means the schema default, which is ON since #930 — so on a fresh
    // install this suggestion correctly renders nothing at all.
    isOn: (value) => value === undefined || value === true || value === "true",
    action: "Turn on Focus iRacing Window",
    done: "",
    hideWhenOn: true,
  },
});

export class EnableFeature extends HTMLElement {
  static readonly observedAttributes = ["feature"];

  private connected = false;
  private settings: Record<string, unknown> = {};
  private settingsLoaded = false;
  private container: HTMLDivElement | null = null;

  private readonly onGlobalSettings: GlobalSettingsHandler = (ev) => {
    this.settings = ev?.payload?.settings ?? {};
    this.settingsLoaded = true;
    this.render();
  };

  connectedCallback(): void {
    if (this.connected) return;

    this.connected = true;
    this.container = document.createElement("div");
    this.container.className = "ird-enable-feature";
    this.appendChild(this.container);

    const client = streamDeckClient();

    if (client) {
      void this.refresh();
      client.didReceiveGlobalSettings.subscribe(this.onGlobalSettings);
    }

    this.render();
  }

  disconnectedCallback(): void {
    this.connected = false;

    const client = streamDeckClient();

    client?.didReceiveGlobalSettings.unsubscribe?.(this.onGlobalSettings);

    // Drop the container too. Without this a re-attach appends a SECOND one
    // beside the first, which is frozen at whatever it last rendered — two
    // buttons, or a button beside a stale confirmation.
    this.container?.remove();
    this.container = null;
  }

  /** Pull the current settings and re-render; ignored once detached. */
  private async refresh(): Promise<void> {
    const settings = await streamDeckClient()?.getGlobalSettings();

    // A late resolve after disconnect must not resurrect a detached element.
    if (!this.connected) return;

    this.settings = settings ?? {};
    this.settingsLoaded = true;
    this.render();
  }

  attributeChangedCallback(): void {
    if (this.connected) this.render();
  }

  private render(): void {
    if (!this.container) return;

    const copy = ENABLE_FEATURE_COPY[this.getAttribute("feature") ?? ""];

    this.container.replaceChildren();

    // An unknown feature renders nothing rather than a dead button. The EJS
    // partial already fails the BUILD on an id it cannot place, so reaching
    // here means markup written by hand.
    if (!copy) return;

    // Render nothing until the settings have actually arrived: an offer that
    // flips to a confirmation a moment later reads as a control that did
    // something on its own.
    if (!this.settingsLoaded) return;

    if (copy.isOn(this.settings[copy.key])) {
      if (copy.hideWhenOn || !copy.done) return;

      const done = document.createElement("p");

      done.className = "ird-enable-feature-done";
      done.textContent = copy.done;
      this.container.appendChild(done);

      return;
    }

    const button = document.createElement("button");

    button.type = "button";
    button.className = "ird-enable-feature-button";
    button.textContent = copy.action;
    button.addEventListener("click", () => {
      // No optimistic re-render: the plugin writes the settings and the
      // resulting didReceiveGlobalSettings is what flips this control. So the
      // confirmation means the write actually landed, rather than that a
      // button was pressed.
      sendToPlugin({ event: "enableFeature", feature: this.getAttribute("feature") });
    });

    this.container.appendChild(button);
  }
}

if (!customElements.get("ird-enable-feature")) customElements.define("ird-enable-feature", EnableFeature);
