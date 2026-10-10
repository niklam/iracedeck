/**
 * Unit tests for the pit-window "pits are open / closed" diff (issue #655).
 *
 * The cue fires on a genuine `PitsOpen` boolean transition in a race session,
 * stays silent on the first (seeding) tick and outside race sessions. The
 * baseline advances every tick so a transition that happens while the gate is
 * closed is absorbed, not replayed. A replay tick never reaches it: the
 * translator's guard holds every one back (#1324).
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffPitsOpen } from "./pits-open.js";
import type { PendingEvent } from "./types.js";

function feed(state: TranslatorState, pitsOpen: boolean, { race = true }: { race?: boolean } = {}): PendingEvent[] {
  const events: PendingEvent[] = [];
  const telemetry = { PitsOpen: pitsOpen } as TelemetryData;
  diffPitsOpen(state, telemetry, race, (e) => events.push(e));

  return events;
}

const OPENED = { event: "pitsOpen.changed", data: { from: false, to: true } } as const;
const CLOSED = { event: "pitsOpen.changed", data: { from: true, to: false } } as const;

describe("diffPitsOpen", () => {
  it("seeds on the first tick without firing", () => {
    const state = createInitialState();
    const events = feed(state, true);

    expect(events).toEqual([]);
    expect(state.pitsOpenInitialized).toBe(true);
    expect(state.lastPitsOpen).toBe(true);
  });

  it("fires 'opened' on a false → true transition in a race", () => {
    const state = createInitialState();
    feed(state, false); // seed closed
    const events = feed(state, true);

    expect(events).toEqual([OPENED]);
  });

  it("fires 'closed' on a true → false transition in a race", () => {
    const state = createInitialState();
    feed(state, true); // seed open
    const events = feed(state, false);

    expect(events).toEqual([CLOSED]);
  });

  it("does not fire on an unchanged tick", () => {
    const state = createInitialState();
    feed(state, false); // seed
    expect(feed(state, false)).toEqual([]);
    feed(state, true); // open
    expect(feed(state, true)).toEqual([]);
  });

  it("suppresses transitions outside a race session", () => {
    const state = createInitialState();
    feed(state, false, { race: false }); // seed
    const events = feed(state, true, { race: false });

    expect(events).toEqual([]);
  });

  it("absorbs a non-race transition so it does not replay when racing resumes", () => {
    const state = createInitialState();
    feed(state, false); // seed closed (race)
    feed(state, true, { race: false }); // opens off-camera (non-race) — suppressed, baseline advances
    const events = feed(state, true); // back in race, still open → no change

    expect(events).toEqual([]);
    expect(state.lastPitsOpen).toBe(true);
  });

  it("treats a missing PitsOpen as closed", () => {
    const state = createInitialState();
    const events: PendingEvent[] = [];
    diffPitsOpen(state, {} as TelemetryData, true, (e) => events.push(e));
    expect(events).toEqual([]); // seed
    expect(state.lastPitsOpen).toBe(false);
  });
});
