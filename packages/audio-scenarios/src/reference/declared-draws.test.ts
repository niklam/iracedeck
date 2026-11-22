import type { CalloutScript } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import { type ContractFrame, declaredDrawReferences, type DeclaringVar } from "./declared-draws.js";

// The spotter's shape: one var, its call lines scoped to the call contract and
// its info line to the info contract, beside a var with an unscoped draw and
// one that declared none.

const CALL = "pit-crew.spotter-call";
const INFO = "pit-crew.spotter-info";

const VARS: readonly DeclaringVar[] = [
  {
    name: "spotterClip",
    draws: [
      { group: "spotter", base: "car-left", contracts: [CALL] },
      { group: "spotter", base: "clear", contracts: [INFO] },
    ],
  },
  { name: "radioCheck", draws: [{ group: "radio", base: "check" }] },
  { name: "position.number" },
];

/** A body that plays a clip, so the engine frames it. */
const BODY = ["pool:spotter/car-right"];

const CONTRACTS: readonly ContractFrame[] = [
  { id: CALL, frame: "none", endsOnEvent: null },
  { id: INFO, frame: "none", endsOnEvent: null },
  { id: "pit-crew.flag-green", frame: "radio", endsOnEvent: null },
];

function script(parts: Partial<CalloutScript>): CalloutScript {
  return { schema: 1, scenarios: {}, frames: {}, pools: {}, fragments: {}, ...parts } as CalloutScript;
}

const reach = (s: CalloutScript, contracts: readonly ContractFrame[] = CONTRACTS) =>
  Object.fromEntries(declaredDrawReferences(s, VARS, contracts));

describe("declaredDrawReferences (issue #1718)", () => {
  it("reaches a scoped pool only through a live entry of one of its contracts", () => {
    expect(reach(script({ scenarios: { [CALL]: { sequence: ["{{spotterClip}}"] } } }))).toEqual({
      "spotter/car-left": ["spotterClip"],
    });
    expect(
      reach(
        script({
          scenarios: { [CALL]: { sequence: ["{{spotterClip}}"] }, [INFO]: { sequence: [{ var: "spotterClip" }] } },
        }),
      ),
    ).toEqual({ "spotter/car-left": ["spotterClip"], "spotter/clear": ["spotterClip"] });
    // `skip: true` is no entry, and another callout naming the var is not one of the contracts.
    expect(
      reach(
        script({
          scenarios: {
            [CALL]: { skip: true },
            "pit-crew.flag-green": { frame: "none", sequence: ["{{spotterClip}}"] },
          },
        }),
      ),
    ).toEqual({});
  });

  it("reaches a pool through any branch of the entry's steps", () => {
    const s = script({
      scenarios: {
        [CALL]: { sequence: [{ if: "session.isRace", then: [], else: [{ optional: ["{{spotterClip}}"] }] }] },
      },
    });

    expect(reach(s)).toEqual({ "spotter/car-left": ["spotterClip"] });
  });

  it("follows the entry's fragments transitively, and no other entry's", () => {
    const fragments = { outer: { sequence: ["@inner"] }, inner: { sequence: ["{{spotterClip}}"] } };

    expect(reach(script({ scenarios: { [CALL]: { sequence: ["@outer"] } }, fragments }))).toEqual({
      "spotter/car-left": ["spotterClip"],
    });
    // The fragment is live — the flag entry includes it — but not through the call.
    expect(
      reach(
        script({
          scenarios: { [CALL]: { sequence: [] }, "pit-crew.flag-green": { sequence: ["@outer"] } },
          fragments,
        }),
      ),
    ).toEqual({});
  });

  it("reads the entry's frame — its own `frame`, else its contract's default — and never `none`", () => {
    const frames = {
      radio: { open: ["{{spotterClip}}"], close: [] },
      spotter: { open: [], close: [], cut: ["@tail"] },
    };
    const fragments = { tail: { sequence: ["{{spotterClip}}"] } };

    // Its own frame, through the frame's cut and a fragment that includes — for a contract carrying `endsOn`,
    // the only kind whose end plays the cut; for any other the cut is never heard, so it names nothing.
    const endable: readonly ContractFrame[] = [
      { id: CALL, frame: "none", endsOnEvent: "flag.green" as ContractFrame["endsOnEvent"] },
    ];

    expect(
      reach(script({ scenarios: { [CALL]: { frame: "spotter", sequence: BODY } }, frames, fragments }), endable),
    ).toEqual({ "spotter/car-left": ["spotterClip"] });
    expect(reach(script({ scenarios: { [CALL]: { frame: "spotter", sequence: BODY } }, frames, fragments }))).toEqual(
      {},
    );
    // The contract's default frame when the entry names none.
    expect(
      reach(script({ scenarios: { [CALL]: { sequence: BODY } }, frames }), [
        { id: CALL, frame: "radio", endsOnEvent: null },
        { id: INFO, frame: "none", endsOnEvent: null },
      ]),
    ).toEqual({ "spotter/car-left": ["spotterClip"] });
    // Unframed by default, and `frame: "none"` over a framed default.
    expect(reach(script({ scenarios: { [CALL]: { sequence: BODY } }, frames }))).toEqual({});
    expect(
      reach(script({ scenarios: { [CALL]: { frame: "none", sequence: BODY } }, frames }), [
        { id: CALL, frame: "radio", endsOnEvent: null },
      ]),
    ).toEqual({});
    // A frame the script does not define names nothing.
    expect(reach(script({ scenarios: { [CALL]: { frame: "missing", sequence: BODY } }, frames }))).toEqual({});
  });

  it("reads no frame around a body that can never play a clip, as the engine expands none", () => {
    const frames = { radio: { open: ["{{spotterClip}}"], close: [] } };
    const framed: readonly ContractFrame[] = [{ id: CALL, frame: "radio", endsOnEvent: null }];

    expect(reach(script({ scenarios: { [CALL]: { sequence: [] } }, frames }), framed)).toEqual({});
    expect(reach(script({ scenarios: { [CALL]: { sequence: [{ pause: 300 }] } }, frames }), framed)).toEqual({});
    expect(reach(script({ scenarios: { [CALL]: { sequence: BODY } }, frames }), framed)).toEqual({
      "spotter/car-left": ["spotterClip"],
    });
  });

  it("reaches an unscoped pool on any live mention — an entry, a frame or an included fragment — and not a dead one", () => {
    expect(reach(script({ scenarios: { "pit-crew.flag-green": { sequence: ["{{radioCheck}}"] } } }))).toEqual({
      "radio/check": ["radioCheck"],
    });
    expect(reach(script({ frames: { radio: { open: ["{{radioCheck}}"], close: [] } } }))).toEqual({
      "radio/check": ["radioCheck"],
    });
    expect(
      reach(
        script({
          scenarios: { "pit-crew.flag-green": { sequence: ["@helper"] } },
          fragments: { helper: { sequence: ["{{radioCheck}}"] } },
        }),
      ),
    ).toEqual({ "radio/check": ["radioCheck"] });
    // A fragment nothing live includes, and a skipped entry, are no mention.
    expect(
      reach(
        script({
          scenarios: { "pit-crew.flag-green": { skip: true } },
          fragments: { helper: { sequence: ["{{radioCheck}}"] } },
        }),
      ),
    ).toEqual({});
  });

  it("lists every var that draws a pool, sorted, and ignores a var that declared none", () => {
    const vars: readonly DeclaringVar[] = [
      { name: "zeta", draws: [{ group: "spotter", base: "clear" }] },
      { name: "alpha", draws: [{ group: "spotter", base: "clear", contracts: [INFO] }] },
      { name: "position.number" },
    ];
    const s = script({
      scenarios: { [INFO]: { sequence: ["{{alpha}}", "{{zeta}}", "{{position.number}}"] } },
    });

    expect(Object.fromEntries(declaredDrawReferences(s, vars, CONTRACTS))).toEqual({
      "spotter/clear": ["alpha", "zeta"],
    });
    expect(declaredDrawReferences(s, [{ name: "position.number" }], CONTRACTS).size).toBe(0);
  });
});
