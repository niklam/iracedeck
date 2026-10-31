/**
 * The two harness lists that are complete only by convention (#1376): every
 * bus event gets a raw-injector template in `EVENT_TEMPLATES`, and every
 * callout gets a way to audition it — a button in `SCENARIO_SHORTCUTS` that its
 * script entry's `test` line names (`.claude/rules/race-engineer-callouts.md`,
 * step 8: "names this button as `Harness → <Category> → <Label>`").
 *
 * - The event list is held to `SimEventMap` both ways by the compile-time
 *   check at the bottom of `event-names.ts` (`_coverageCheck`); the bus
 *   exports the catalog as a type only, so there is no runtime list to compare
 *   against. What the compiler cannot see is a name listed twice, which is
 *   checked here.
 * - The callout list is held to the contracts the real registration makes, in
 *   every published voice's script, because the `test` line is what joins a
 *   contract to its button. The line resolves to the shortcut whose path it
 *   opens with — the longest such path, so a label that prefixes another
 *   ("Green" and "Green Held") resolves to the button it names — and when the
 *   contract fires on an event and that shortcut publishes events, the
 *   contract's event must be among them, so a line cannot name a button that
 *   plays some other callout. Two pairings are out of that check's reach: a
 *   shortcut that drives telemetry rather than publishing (the translator
 *   decides what it fires; its heard tests cover it), and a contract with no
 *   `event` (the spotter's, fed by the radar engine). The few contracts with no
 *   button, or whose line opens with a setup press, are listed below, each
 *   with its reason, and each entry is checked so it cannot go stale.
 * - Every published voice's script names exactly the registered contracts,
 *   which is also what keeps an empty or shrunken registration from passing
 *   every other check here.
 * - In the other direction, every shortcut that publishes an event must publish
 *   one a contract fires on, so a callout moved to another event cannot leave
 *   its button publishing the old one. Telemetry-sequence shortcuts drive the
 *   translator rather than naming an event, so they are out of this check's
 *   reach; their own heard tests cover them.
 */
import { _resetAudioScenarios, type ContractReport, initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import { registerPitCrew } from "@iracedeck/audio-scenarios/pit-crew";
import type { IAudioService } from "@iracedeck/audio-service";
import { _resetEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getAudioAssetsManifest } from "./bootstrap-settings.js";
import { EVENT_TEMPLATES } from "./event-names.js";
import { SCENARIO_SHORTCUTS, type ScenarioShortcut } from "./scenario-shortcuts.js";
import { loadBundledVoiceScripts } from "./voice-scripts.js";

const UI_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html"), "utf8");

/**
 * Contracts auditioned from a dedicated harness panel rather than a shortcut
 * button: their payload is composed in the panel's own controls (a service
 * snapshot, a session type), which a one-click button cannot offer. The test
 * line names the panel's heading and its button; both are checked against
 * `ui/index.html`.
 */
const PANEL_AUDITIONS: Readonly<Record<string, { panel: string; button: string }>> = {
  "pit-crew.pit-readback-entry": { panel: "Pit Service Readback", button: "Fire Readback" },
  "pit-crew.pit-readback-exit": { panel: "Pit Service Readback", button: "Fire Readback" },
  "pit-crew.session-start": { panel: "Session Start", button: "Fire Session Start" },
};

/**
 * Contracts that are mute in the harness by design: the position readout that
 * follows an overtake reaction speaks the live race position, which the
 * harness does not have, so no button can make it speak. Their test lines say
 * so with the `Harness: mute` prefix, which is checked.
 */
const MUTE_IN_HARNESS: readonly string[] = ["pit-crew.overtake-gained-position", "pit-crew.overtake-lost-position"];

/**
 * Contracts whose test line opens with a setup press and names the button that
 * fires the contract after it, as `<setup path>, then <firing path>`. The
 * contract's event is checked against the firing button, which the line must
 * name that way.
 *
 * - `pit-crew.flag-furled-cleared`: its speak gate drops the cleared line
 *   unless the furled line itself reached the speaker (`flag-alerts.ts`), so
 *   "Furled Cleared" pressed on its own is silent by design and the audition
 *   raises the furled flag first.
 */
const SETUP_PRESS_FIRST: Readonly<Record<string, string>> = {
  "pit-crew.flag-furled-cleared": "Harness → Flags → Furled Cleared",
};

/**
 * Events a catalog engine consumes directly rather than through a contract's
 * `event`: `radar.changed` feeds the radar and spotter engines (whose
 * spotter contracts carry no event), and the two `pitSpeeding` edges open and
 * close the pit-speeding engine's tick loop.
 */
const ENGINE_EVENTS: readonly SimEventName[] = ["radar.changed", "pitSpeeding.started", "pitSpeeding.ended"];

/**
 * Shortcuts that publish an event nothing in the Race Engineer reads today
 * (measured by #1376: no contract fires on it and no catalog engine subscribes
 * to it), so pressing one only shows the event in the bus log. Listed as found;
 * a callout that starts listening to one of these events fails the check below
 * until its shortcut is taken off this list.
 */
const UNHEARD_SHORTCUTS: readonly string[] = [
  "pit-entered",
  "stall-entered",
  "stall-departed",
  "off-track-started",
  "off-track-ended",
];

/** The harness paths a `test` line may name a shortcut by: the category directly, or under the panel's heading. */
function shortcutPaths(shortcut: ScenarioShortcut): string[] {
  return [
    `Harness → ${shortcut.category} → ${shortcut.label}`,
    `Harness → Scenario Shortcuts → ${shortcut.category} → ${shortcut.label}`,
  ];
}

/** Whether `test` opens with `path`, ending on a word boundary so a label cannot match a longer one it prefixes. */
function opensWith(test: string, path: string): boolean {
  return test.startsWith(path) && !/^[\p{L}\p{N}]/u.test(test.slice(path.length));
}

/**
 * The shortcut `text` opens with: of every shortcut path it opens with, the
 * longest, so "Harness → Flags → Green Held" resolves to "Green Held" and not
 * to "Green", whose path it also opens with. `undefined` when it opens with
 * none. Unambiguous because no two shortcuts share a path (checked below).
 */
function namedShortcut(text: string): ScenarioShortcut | undefined {
  let named: { shortcut: ScenarioShortcut; length: number } | undefined;

  for (const shortcut of SCENARIO_SHORTCUTS) {
    for (const path of shortcutPaths(shortcut)) {
      if (opensWith(text, path) && (named === undefined || path.length > named.length)) {
        named = { shortcut, length: path.length };
      }
    }
  }

  return named?.shortcut;
}

/** Every bus event a bus-event shortcut publishes, its preceding events included. */
function publishedEvents(shortcut: ScenarioShortcut): SimEventName[] {
  if (shortcut.event === undefined) return [];

  return [...(shortcut.precedingEvents ?? []).map((e) => e.event), shortcut.event];
}

/** `text` as a regular expression source that matches it literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("EVENT_TEMPLATES covers SimEventMap (#1376)", () => {
  // Missing and extra names are `event-names.ts`'s own compile-time check.
  it("lists each event once", () => {
    const names = EVENT_TEMPLATES.map((t) => t.name);
    const repeated = names.filter((name, i) => names.indexOf(name) !== i);

    expect(names.length).toBeGreaterThan(0);
    expect(repeated, "event names with more than one template").toEqual([]);
  });
});

describe("every callout can be auditioned from the harness (#1376)", () => {
  const scripts = loadBundledVoiceScripts();
  let contracts: readonly ContractReport[];

  beforeAll(() => {
    const bus = initializeEventBus(silentLogger);
    // Registration only: nothing is published, so the audio service is never asked for anything that matters.
    const audio = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (target[key] ??= vi.fn()),
    }) as unknown as IAudioService;
    const engine = initializeAudioScenarios(bus, audio, getAudioAssetsManifest(), silentLogger, () => "default");

    registerPitCrew(bus, {});
    contracts = engine.contracts();
  });

  afterAll(() => {
    _resetAudioScenarios();
    _resetEventBus();
  });

  it("sees the registration: every published voice's script names exactly the registered contracts", () => {
    // Also the vacuity floor: an empty or shrunken registration would pass every check below.
    const registered = new Set(contracts.map((c) => c.id));
    const drift = [...scripts].map(([voice, script]) => ({
      voice,
      unscripted: [...registered].filter((id) => !Object.hasOwn(script.scenarios, id)),
      unregistered: Object.keys(script.scenarios).filter((id) => !registered.has(id)),
    }));

    expect(registered.size, "registered contracts").toBeGreaterThan(0);
    expect(drift).toEqual([...scripts.keys()].map((voice) => ({ voice, unscripted: [], unregistered: [] })));
  });

  it("gives every shortcut a path of its own, so a test line names one button", () => {
    const paths = SCENARIO_SHORTCUTS.map((s) => `${s.category} → ${s.label}`);
    const repeated = paths.filter((path, i) => paths.indexOf(path) !== i);

    expect(repeated, "category → label pairs more than one shortcut carries").toEqual([]);
  });

  it.each([...scripts])(
    "voice %s: every contract's test line names a harness button that fires it",
    (voice, script) => {
      const problems: string[] = [];

      for (const { id, event } of contracts) {
        const test = script.scenarios[id]?.test;

        if (test === undefined) {
          problems.push(`${id}: no test line in voice/${voice}/callouts.json`);
          continue;
        }

        if (MUTE_IN_HARNESS.includes(id)) {
          if (!test.startsWith("Harness: mute"))
            problems.push(`${id}: listed as mute in the harness, but its test line is "${test}"`);

          continue;
        }

        if (Object.hasOwn(PANEL_AUDITIONS, id)) {
          const { panel, button } = PANEL_AUDITIONS[id];

          if (!opensWith(test, `Harness → ${panel} → ${button}`)) {
            problems.push(`${id}: listed as auditioned from "${panel} → ${button}", but its test line is "${test}"`);
          }

          continue;
        }

        const named = namedShortcut(test);

        if (named === undefined) {
          problems.push(
            `${id}: the test line names no shortcut — add a button to scenario-shortcuts.ts and name it as ` +
              `"Harness → <Category> → <Label>" (or list the contract above with its reason): "${test}"`,
          );
          continue;
        }

        let fires = named;

        if (Object.hasOwn(SETUP_PRESS_FIRST, id)) {
          const firing = SETUP_PRESS_FIRST[id];
          const at = test.indexOf(`, then ${firing}`);
          const resolved = at === -1 ? undefined : namedShortcut(test.slice(at + ", then ".length));

          if (resolved === undefined || !shortcutPaths(resolved).includes(firing)) {
            problems.push(`${id}: listed as fired by "${firing}" after a setup press, but its test line is "${test}"`);
            continue;
          }

          fires = resolved;
        }

        const published = publishedEvents(fires);

        if (event !== null && published.length > 0 && !published.includes(event)) {
          problems.push(
            `${id}: fires on ${event}, but the shortcut its test line names ("${fires.category} → ${fires.label}") ` +
              `publishes ${published.join(", ")}: "${test}"`,
          );
        }
      }

      expect(problems).toEqual([]);
    },
  );

  it("lists only registered contracts as exceptions", () => {
    const ids = new Set(contracts.map((c) => c.id));
    const stale = [...MUTE_IN_HARNESS, ...Object.keys(PANEL_AUDITIONS), ...Object.keys(SETUP_PRESS_FIRST)].filter(
      (id) => !ids.has(id),
    );

    expect(stale, "exceptions naming no registered contract").toEqual([]);
  });

  it("names panels and buttons the harness UI has", () => {
    for (const { panel, button } of Object.values(PANEL_AUDITIONS)) {
      expect(UI_HTML, `the harness UI has no "${panel}" panel`).toContain(`<h2>${panel}</h2>`);
      expect(UI_HTML, `the harness UI has no "${button}" button`).toMatch(
        new RegExp(`<button[^>]*>${escapeRegExp(button)}</button>`),
      );
    }
  });

  it("gives every bus-event shortcut an event something in the Race Engineer fires on", () => {
    const heard = new Set<SimEventName>([
      ...contracts.flatMap((c) => (c.event === null ? [] : [c.event])),
      ...ENGINE_EVENTS,
    ]);
    const unheard = SCENARIO_SHORTCUTS.filter((s) => s.event !== undefined)
      .filter((s) => !publishedEvents(s).some((event) => heard.has(event)))
      .map((s) => s.id);

    expect(unheard.sort(), "shortcuts publishing only events no contract or catalog engine reads").toEqual(
      [...UNHEARD_SHORTCUTS].sort(),
    );
  });
});
