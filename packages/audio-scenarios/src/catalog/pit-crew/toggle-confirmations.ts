/**
 * Toggle-confirmation scenarios — short engineer voice lines played when the
 * driver toggles a pit-service option or an on-board driver-aid (DRS / P2P).
 *
 * Flow: `@radio-open → pool:acknowledgment → <toggle clip> → @radio-close`.
 * The acknowledgment pool (copy that / got it / …) preserves the walkie
 * talkie feel where the engineer confirms the request before echoing the
 * state change.
 *
 * All scenarios fire on event-driven `where` filters matching a specific
 * `(service, on)` combination. `priority: "normal"` so pit-lane callouts
 * still take precedence.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

type PitService = "fuel" | "windshield" | "fastRepair";

const PIT_SERVICE_CLIP: Record<PitService, { on: string; off: string }> = {
  fuel: {
    on: "pit-crew/toggle/IRD-toggle-fuel-on.mp3",
    off: "pit-crew/toggle/IRD-toggle-fuel-off.mp3",
  },
  windshield: {
    on: "pit-crew/toggle/IRD-toggle-windshield-on.mp3",
    off: "pit-crew/toggle/IRD-toggle-windshield-off.mp3",
  },
  fastRepair: {
    on: "pit-crew/toggle/IRD-toggle-fast-repair-on.mp3",
    off: "pit-crew/toggle/IRD-toggle-fast-repair-off.mp3",
  },
};

function toggleSequence(clip: string): Scenario["sequence"] {
  return ["@pit-crew.radio-open", "pool:acknowledgment", clip, "@pit-crew.radio-close"];
}

function pitServiceScenario(service: PitService, on: boolean): Scenario {
  const clip = (on ? PIT_SERVICE_CLIP[service].on : PIT_SERVICE_CLIP[service].off).replace(/^pit-crew\//, "");

  return {
    id: `pit-crew.toggle-${service}-${on ? "on" : "off"}`,
    when: {
      event: "pitService.toggled",
      where: (e) => {
        const data = (e as SimEventOf<"pitService.toggled">).data;

        return data.service === service && data.on === on;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "pit-crew",
    priority: "normal",
    sequence: toggleSequence(clip),
  };
}

function carControlScenario(kind: "drs" | "p2p", on: boolean): Scenario {
  const fileStub = kind === "drs" ? "drs" : "p2p";
  const event = kind === "drs" ? "carControl.drsToggled" : "carControl.p2pToggled";

  return {
    id: `pit-crew.toggle-${kind}-${on ? "on" : "off"}`,
    when: {
      event,
      where: (e) => (e as SimEventOf<"carControl.drsToggled" | "carControl.p2pToggled">).data.on === on,
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "pit-crew",
    priority: "normal",
    sequence: toggleSequence(`toggle/IRD-toggle-${fileStub}-${on ? "on" : "off"}.mp3`),
  };
}

export const TOGGLE_CONFIRMATIONS: readonly Scenario[] = [
  pitServiceScenario("fuel", true),
  pitServiceScenario("fuel", false),
  pitServiceScenario("windshield", true),
  pitServiceScenario("windshield", false),
  pitServiceScenario("fastRepair", true),
  pitServiceScenario("fastRepair", false),
  carControlScenario("drs", true),
  carControlScenario("drs", false),
  carControlScenario("p2p", true),
  carControlScenario("p2p", false),
];

export const TOGGLE_SCENARIO_IDS: readonly string[] = TOGGLE_CONFIRMATIONS.map((s) => s.id);
