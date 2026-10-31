/**
 * The two harness lists that are complete only by convention (#1376): every
 * bus event gets a raw-injector template in `EVENT_TEMPLATES`, and every
 * callout gets a way to audition it — a button in `SCENARIO_SHORTCUTS` that its
 * script entry's `test` line names (`.claude/rules/race-engineer-callouts.md`,
 * step 8: "names this button as `Harness → <Category> → <Label>`").
 *
 * - The event list is held to `SimEventMap` by the compiler, both ways. The bus
 *   exports the catalog as a type only, so there is no runtime list to compare
 *   against; `expectTypeOf` below fails `pnpm typecheck` on a missing or an
 *   extra name, without a second hand-kept copy of the names here that every
 *   new event would have to edit. The runtime half is what the compiler cannot
 *   see: a name listed twice.
 * - The callout list is held to the contracts the real registration makes, in
 *   every published voice's script, because the `test` line is what joins a
 *   contract to its button. The few contracts with no button are listed below,
 *   each with its reason, and each entry is checked so it cannot go stale.
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
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";

import { getAudioAssetsManifest } from "./bootstrap-settings.js";
import { ALL_EVENT_NAMES, EVENT_TEMPLATES } from "./event-names.js";
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

/** Every bus event a bus-event shortcut publishes, its preceding events included. */
function publishedEvents(shortcut: ScenarioShortcut): SimEventName[] {
  if (shortcut.event === undefined) return [];

  return [...(shortcut.precedingEvents ?? []).map((e) => e.event), shortcut.event];
}

describe("EVENT_TEMPLATES covers SimEventMap (#1376)", () => {
  it("lists exactly the catalog's event names — enforced by the compiler, both ways", () => {
    type Covered = (typeof EVENT_TEMPLATES)[number]["name"];

    // An event in the catalog with no template, then a template naming no
    // event: two assertions, so the compiler's error names the side and the names.
    expectTypeOf<Exclude<SimEventName, Covered>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<Covered, SimEventName>>().toEqualTypeOf<never>();
  });

  it("lists each event once", () => {
    const names = EVENT_TEMPLATES.map((t) => t.name);
    const repeated = names.filter((name, i) => names.indexOf(name) !== i);

    expect(names.length).toBeGreaterThan(0);
    expect(repeated, "event names with more than one template").toEqual([]);
  });

  it("feeds the injector exactly the templates' names, in order", () => {
    expect(ALL_EVENT_NAMES).toEqual(EVENT_TEMPLATES.map((t) => t.name));
  });
});

describe("every callout can be auditioned from the harness (#1376)", () => {
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

  it("sees the registration", () => {
    // Vacuity floor: an empty set would pass every check below.
    expect(contracts.length).toBeGreaterThan(100);
  });

  it.each([...loadBundledVoiceScripts()])(
    "voice %s: every contract's test line names a harness button",
    (voice, script) => {
      const problems: string[] = [];

      for (const { id } of contracts) {
        const test = script.scenarios[id]?.test;

        if (test === undefined) {
          problems.push(`${id}: no test line in voice/${voice}/callouts.json`);
        } else if (MUTE_IN_HARNESS.includes(id)) {
          if (!test.startsWith("Harness: mute"))
            problems.push(`${id}: listed as mute in the harness, but its test line is "${test}"`);
        } else if (Object.hasOwn(PANEL_AUDITIONS, id)) {
          const { panel, button } = PANEL_AUDITIONS[id];

          if (!opensWith(test, `Harness → ${panel} → ${button}`)) {
            problems.push(`${id}: listed as auditioned from "${panel} → ${button}", but its test line is "${test}"`);
          }
        } else if (!SCENARIO_SHORTCUTS.some((s) => shortcutPaths(s).some((path) => opensWith(test, path)))) {
          problems.push(
            `${id}: the test line names no shortcut — add a button to scenario-shortcuts.ts and name it as ` +
              `"Harness → <Category> → <Label>" (or list the contract above with its reason): "${test}"`,
          );
        }
      }

      expect(problems).toEqual([]);
    },
  );

  it("lists only registered contracts as exceptions", () => {
    const ids = new Set(contracts.map((c) => c.id));
    const stale = [...MUTE_IN_HARNESS, ...Object.keys(PANEL_AUDITIONS)].filter((id) => !ids.has(id));

    expect(stale, "exceptions naming no registered contract").toEqual([]);
  });

  it("names panels and buttons the harness UI has", () => {
    for (const { panel, button } of Object.values(PANEL_AUDITIONS)) {
      expect(UI_HTML, `the harness UI has no "${panel}" panel`).toContain(`<h2>${panel}</h2>`);
      expect(UI_HTML, `the harness UI has no "${button}" button`).toMatch(
        new RegExp(`<button[^>]*>${button}</button>`),
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
