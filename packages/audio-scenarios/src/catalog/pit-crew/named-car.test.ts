/**
 * The memory of the car last named (issue #1286), as the caution and the
 * rolling-start formation both use it. The families' own tests drive it
 * through their contracts; these pin the mechanism alone.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { ScenarioContext, SpeakGate } from "../../dsl.js";
import { createNamedCarMemory, type NamedCarMemory, type NamingEpisode } from "./named-car.js";

const CTX = { event: null, now: 0 } as ScenarioContext;

let episode: NamingEpisode | null;
let followCarIdx: number | null | undefined;
let memory: NamedCarMemory<NamingEpisode>;

/** A gate that answers what it is told, wrapped so admitting it records the car ahead. */
function namingGate(admits: boolean): SpeakGate {
  return memory.naming({ description: "A gate.", admit: () => admits });
}

/** The change judgement with the car `idx` ahead now, judged against the episode's first car before anything is named. */
function changeTo(idx: number): boolean {
  followCarIdx = idx;

  return memory.admitChange((e) => e.firstFollowCarIdx);
}

beforeEach(() => {
  episode = { id: 1, firstFollowCarIdx: 7 };
  followCarIdx = 7;
  memory = createNamedCarMemory({
    getEpisode: () => episode,
    // `undefined` stands for "no lineup to read"; `null` for a lineup that names no car.
    getPaceLineup: () => (followCarIdx === undefined ? null : { followCarIdx }),
  });
});

describe("createNamedCarMemory", () => {
  it("starts with nothing named", () => {
    expect(memory.read()).toBeNull();
  });

  it("records the car ahead when a naming gate admits, and keeps the gate's own description", () => {
    const gate = namingGate(true);

    expect(gate.description).toBe("A gate.");
    expect(gate.admit(CTX)).toBe(true);
    expect(memory.read()).toEqual({ episodeId: 1, followCarIdx: 7 });
  });

  it("records nothing when the gate refuses", () => {
    expect(namingGate(false).admit(CTX)).toBe(false);
    expect(memory.read()).toBeNull();
  });

  it("admits without recording when no episode runs or the lineup names no car — the call still speaks", () => {
    episode = null;
    expect(namingGate(true).admit(CTX)).toBe(true);

    episode = { id: 1, firstFollowCarIdx: 7 };
    followCarIdx = null;
    expect(namingGate(true).admit(CTX)).toBe(true);

    followCarIdx = undefined;
    expect(namingGate(true).admit(CTX)).toBe(true);

    expect(memory.read()).toBeNull();
  });

  it("judges a change against the reference handed in while nothing is named, and records the car it admits", () => {
    expect(changeTo(7)).toBe(false);
    expect(memory.read()).toBeNull();

    expect(changeTo(12)).toBe(true);
    expect(memory.read()).toEqual({ episodeId: 1, followCarIdx: 12 });
  });

  it("stays silent while the reference is unknown — nothing named and none handed in", () => {
    followCarIdx = 12;

    expect(memory.admitChange(() => null)).toBe(false);
    expect(memory.read()).toBeNull();
  });

  it("judges a change against the car last named, never asking for the other reference", () => {
    followCarIdx = 23;
    expect(namingGate(true).admit(CTX)).toBe(true);

    const unnamedReference = (): number | null => {
      throw new Error("asked for the unnamed reference with a car named");
    };

    expect(memory.admitChange(unnamedReference)).toBe(false);

    followCarIdx = 12;
    expect(memory.admitChange(unnamedReference)).toBe(true);
    // 12 was just named, so it is no longer news; the return to 23 is.
    expect(memory.admitChange(unnamedReference)).toBe(false);

    followCarIdx = 23;
    expect(memory.admitChange(unnamedReference)).toBe(true);
  });

  it("ignores a record from another episode", () => {
    followCarIdx = 12;
    expect(namingGate(true).admit(CTX)).toBe(true);

    episode = { id: 2, firstFollowCarIdx: 12 };

    expect(changeTo(12)).toBe(false);
    expect(changeTo(7)).toBe(true);
    expect(memory.read()).toEqual({ episodeId: 2, followCarIdx: 7 });
  });

  it("refuses a change with no episode running or no car to read", () => {
    episode = null;
    expect(changeTo(12)).toBe(false);

    episode = { id: 1, firstFollowCarIdx: 7 };
    followCarIdx = null;
    expect(memory.admitChange((e) => e.firstFollowCarIdx)).toBe(false);

    followCarIdx = undefined;
    expect(memory.admitChange((e) => e.firstFollowCarIdx)).toBe(false);
  });

  it("keeps two memories apart — a caution's record never answers for a formation", () => {
    const other = createNamedCarMemory({ getEpisode: () => episode, getPaceLineup: () => ({ followCarIdx: 12 }) });

    expect(namingGate(true).admit(CTX)).toBe(true);
    expect(other.read()).toBeNull();
  });
});
