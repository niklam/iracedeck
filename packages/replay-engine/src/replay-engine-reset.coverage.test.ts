import { describe, expect, it } from "vitest";

import {
  bindingKey,
  exemptionProblems,
  readEngineSources,
  type ResetRoot,
  scanResetCoverage,
} from "./replay-engine-reset.coverage.test-support.js";

/**
 * `_resetReplayEngine` is a hand-kept list (#1467), and a module that keeps
 * state and is left off it carries that state from one test into the next.
 * This scans every production source of the engine for module-level state and
 * fails on any binding a call of `_resetReplayEngine` cannot reach and clear
 * (#1502). What counts as state and what counts as a reset is in the scanner's
 * header, `replay-engine-reset.coverage.test-support.ts`.
 */

const ROOT: ResetRoot = { module: "replay-engine-reset.ts", fn: "_resetReplayEngine" };

/**
 * State the reset leaves on purpose, by `<module>:<binding>`, each with why.
 * An entry with no reason, or one the scan no longer reports as unreset, fails.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  "replay-left.ts:listeners":
    "Module wiring: the gate, the paced search, the lap walks and the camera-switch waiter register at load; clearing it would unwire them for every later test.",
  "replay-cursor.ts:takenListeners":
    "Module wiring: the gate and the speed state register at load; clearing it would unwire them for every later test.",
  "lap-press.ts:startListeners":
    "Module wiring: the camera-switch waiter registers at load; clearing it would unwire it for every later test.",
  "replay-position-state.ts:nextId":
    "An identity counter: a target's id is only compared with the target the module issued, which the reset clears. Rising across resets cannot match a cleared target; restarting at 1 could match a snapshot still held from before.",
  "replay-command-gate.ts:takingOrigin":
    "Set and cleared in a try / finally around one synchronous cursor take, and read only while `gateTaking` is true, which the reset clears.",
  "replay-command-gate.ts:batchNow":
    "The time the outermost batch opened: written when `batchDepth` goes from 0 and read only inside a batch; the reset zeroes `batchDepth`, so the next batch writes it first.",
  "replay-command-gate.ts:closedJumps":
    "A WeakMap keyed by jump sequences' cursor claims, read only through a sequence's own handle, so only a handle held from before the reset could reach an entry; a WeakMap has no clear().",
};

describe("_resetReplayEngine covers every stateful module (#1502)", () => {
  const scan = scanResetCoverage(readEngineSources(import.meta.dirname), ROOT);

  it("scans the whole engine, not an empty or narrowed glob", () => {
    // 31 production sources, 10 of them stateful with 48 stateful bindings, on 2026-10-31.
    expect(scan.modules.length).toBeGreaterThanOrEqual(25);
    expect(scan.modules).toContain("replay-engine-reset.ts");
    expect(scan.modules).toContain("replay-cursor.ts");
    expect(new Set(scan.stateful.map((binding) => binding.module)).size).toBeGreaterThanOrEqual(8);
    expect(scan.stateful.length).toBeGreaterThanOrEqual(30);
    expect(scan.reached).toContain("replay-cursor.ts:_resetReplayCursor");
  });

  it("finds the cursor's claim as state that the reset clears", () => {
    const current = scan.stateful.find((binding) => bindingKey(binding) === "replay-cursor.ts:current");

    expect(current).toMatchObject({ kind: "let" });
    expect(scan.reset.map(bindingKey)).toContain("replay-cursor.ts:current");
  });

  it("reports the real engine's state once the root stops calling one module's reset", () => {
    const sources = readEngineSources(import.meta.dirname);
    const root = sources.get(ROOT.module) ?? "";
    const call = "  _resetLapPress();\n";

    expect(root).toContain(call);
    sources.set(ROOT.module, root.replace(call, ""));

    expect(scanResetCoverage(sources, ROOT).unreset.map(bindingKey)).toContain("lap-press.ts:activeLapPress");
  });

  it("leaves no module state unreset but the exemptions", () => {
    const missing = scan.unreset
      .filter((binding) => !(bindingKey(binding) in EXEMPT))
      .map((binding) => `${bindingKey(binding)} (line ${binding.line}, ${binding.kind})`);

    expect(missing, "reset these from _resetReplayEngine, or exempt them with the reason").toEqual([]);
  });

  it("keeps every exemption justified and current", () => {
    expect(exemptionProblems(scan.unreset, EXEMPT)).toEqual([]);
  });
});

/** A planted engine: `replay-engine-reset.ts` plus the given modules. */
function planted(root: string, modules: Record<string, string>): Map<string, string> {
  return new Map([["replay-engine-reset.ts", root], ...Object.entries(modules)]);
}

const unreset = (sources: Map<string, string>): string[] => scanResetCoverage(sources, ROOT).unreset.map(bindingKey);
const stateful = (sources: Map<string, string>): string[] => scanResetCoverage(sources, ROOT).stateful.map(bindingKey);

describe("the reset-coverage scanner (positive controls)", () => {
  it("reports a stateful module with no reset", () => {
    const sources = planted(`export function _resetReplayEngine(): void {}`, {
      "counter.ts": `let count = 0;\nexport function bump(): number { return ++count; }`,
    });

    expect(unreset(sources)).toEqual(["counter.ts:count"]);
  });

  it("reports a module whose reset the root never calls", () => {
    const sources = planted(
      `import { _resetA } from "./a.js";\nexport function _resetReplayEngine(): void { _resetA(); }`,
      {
        "a.ts": `let a: string | null = null;\nexport function setA(v: string): void { a = v; }\nexport function _resetA(): void { a = null; }`,
        "cache.ts": `const cache = new Map<string, number>();\nexport function put(k: string): void { cache.set(k, 1); }\nexport function _resetCache(): void { cache.clear(); }`,
      },
    );
    const scan = scanResetCoverage(sources, ROOT);

    expect(scan.unreset.map(bindingKey)).toEqual(["cache.ts:cache"]);
    expect(scan.reset.map(bindingKey)).toEqual(["a.ts:a"]);
  });

  it("follows the root through hops, re-exports and namespace imports", () => {
    const sources = planted(
      `import { _resetA } from "./a.js";\nimport * as b from "./barrel.js";\nexport function _resetReplayEngine(): void { _resetA(); b._resetB(); }`,
      {
        "a.ts": `import { clearDeep } from "./deep.js";\nlet a = 1;\nconst helper = (): void => { a = 1; clearDeep(); };\nexport function _resetA(): void { helper(); }`,
        "deep.ts": `export let deep: number[] = [];\nexport function clearDeep(): void { deep.length = 0; }`,
        "barrel.ts": `export { _resetB } from "./b.js";`,
        "b.ts": `const seen = new Set<number>();\nexport function note(n: number): void { seen.add(n); }\nexport function _resetB(): void { seen.clear(); }`,
      },
    );
    const scan = scanResetCoverage(sources, ROOT);

    expect(scan.unreset).toEqual([]);
    expect(scan.reset.map(bindingKey).sort()).toEqual(["a.ts:a", "b.ts:seen", "deep.ts:deep"]);
  });

  it("counts only a clearing write as a reset: reassignment, clear() or length = 0", () => {
    const sources = planted(
      `import { _resetCleared } from "./cleared.js";\nexport function _resetReplayEngine(): void { _resetCleared(); }`,
      {
        "cleared.ts": [
          "let current: string | null = null;",
          "let generation = 0;",
          "const seen = new Set<number>();",
          "const list: number[] = [];",
          "export function note(n: number): void { current = 'x'; generation += 1; seen.add(n); list.push(n); }",
          "export function _resetCleared(): void { current = null; generation++; seen!.clear(); list.length = 0; }",
        ].join("\n"),
      },
    );
    const scan = scanResetCoverage(sources, ROOT);

    expect(scan.unreset).toEqual([]);
    expect(scan.reset.map(bindingKey)).toEqual([
      "cleared.ts:current",
      "cleared.ts:generation",
      "cleared.ts:seen",
      "cleared.ts:list",
    ]);
  });

  it("does not count a reached write that adds, sets, assigns a property or clears a part", () => {
    const sources = planted(
      `import { _resetWrites } from "./writes.js";\nexport function _resetReplayEngine(): void { _resetWrites(); }`,
      {
        "writes.ts": [
          "const list: number[] = [];",
          "const cache = new Map<string, number>();",
          "const state = { count: 0 };",
          "const holder = { items: new Set<number>() };",
          "let queue: number[] = [];",
          "export function note(n: number): void { list.push(n); cache.set('k', n); state.count++; holder.items.add(n); queue.push(n); }",
          "export function _resetWrites(): void { list.push(0); cache.set('k', 0); state.count = 0; holder.items.clear(); queue.splice(0, 1); }",
        ].join("\n"),
      },
    );
    const scan = scanResetCoverage(sources, ROOT);

    expect(scan.reset).toEqual([]);
    expect(scan.unreset.map(bindingKey)).toEqual([
      "writes.ts:list",
      "writes.ts:cache",
      "writes.ts:state",
      "writes.ts:holder",
      "writes.ts:queue",
    ]);
  });

  it("does not count a write or a call inside a closure the reached function only defines", () => {
    const sources = planted(
      `import { _resetLater } from "./later.js";\nexport function _resetReplayEngine(): void { _resetLater(); }`,
      {
        "later.ts": [
          "let pending: string | null = null;",
          "let other: string | null = null;",
          "const seen = new Set<number>();",
          "export function hold(v: string): void { pending = v; other = v; seen.add(1); }",
          "function clearOther(): void { other = null; }",
          "export function _resetLater(): void {",
          "  setTimeout(() => { pending = null; }, 0);",
          "  const later = (): void => clearOther();",
          "  void later;",
          "  void { wipe() { seen.clear(); } };",
          "}",
        ].join("\n"),
      },
    );
    const scan = scanResetCoverage(sources, ROOT);

    expect(scan.unreset.map(bindingKey)).toEqual(["later.ts:pending", "later.ts:other", "later.ts:seen"]);
    expect(scan.reached).not.toContain("later.ts:clearOther");
  });

  it("does not take a nested binding of the same name for the module's", () => {
    const sources = planted(
      `import { _resetCount } from "./counter.js";\nexport function _resetReplayEngine(): void { _resetCount(); }`,
      {
        "counter.ts": `let count = 0;\nexport function bump(): number { return ++count; }\nexport function _resetCount(): void { let count = 5; count = 0; void count; }`,
      },
    );

    expect(unreset(sources)).toEqual(["counter.ts:count"]);
  });

  it("counts a const as state only when something writes it, here or through an import", () => {
    const sources = planted(`export function _resetReplayEngine(): void {}`, {
      "tables.ts": [
        "// let commented = 1;",
        'const text = "let quoted = 1";',
        "export const TABLE = { speed: 1 };",
        "export const FROZEN = Object.freeze([1, 2, 3]);",
        "export const LOOKUP = new Map([[1, 'a']]);",
        "export const WRITTEN = { speed: 1 };",
        "const LIST: number[] = [];",
        "export function grow(): void { LIST.push(1); }",
        "export function read(): string { let local = text; local += '!'; return local + TABLE.speed + FROZEN[0] + LOOKUP.get(1); }",
      ].join("\n"),
      "writer.ts": `import { WRITTEN } from "./tables.js";\nexport function bend(): void { WRITTEN.speed = 2; }`,
    });

    expect(stateful(sources).sort()).toEqual(["tables.ts:LIST", "tables.ts:WRITTEN"]);
  });

  it("counts a const it cannot see into, and a class's mutable static field", () => {
    const sources = planted(`export function _resetReplayEngine(): void {}`, {
      "opaque.ts": [
        "class Tracker { step(): void {} }",
        "const tracker = new Tracker();",
        "const made = makeThing();",
        "function makeThing(): object { return {}; }",
        "export class Registry { static entries = 0; static readonly NAME = 'r'; }",
        "export class Plain { static readonly NAME = 'p'; }",
        "export const step = (): void => tracker.step();",
        "export const use = (): object => made;",
      ].join("\n"),
    });

    expect(stateful(sources).sort()).toEqual(["opaque.ts:Registry", "opaque.ts:made", "opaque.ts:tracker"]);
  });

  it("refuses a root it cannot find", () => {
    expect(() => scanResetCoverage(planted(`export function other(): void {}`, {}), ROOT)).toThrow(
      "the root replay-engine-reset.ts:_resetReplayEngine was not found",
    );
  });

  it("fails an exemption with no reason, and one that names nothing unreset", () => {
    const sources = planted(`export function _resetReplayEngine(): void {}`, {
      "counter.ts": `let count = 0;\nexport function bump(): number { return ++count; }`,
    });
    const scan = scanResetCoverage(sources, ROOT);

    expect(exemptionProblems(scan.unreset, { "counter.ts:count": " " })).toEqual([
      "counter.ts:count: an exemption needs its reason",
    ]);
    expect(exemptionProblems(scan.unreset, { "counter.ts:gone": "Kept for the whole process on purpose." })).toEqual([
      "counter.ts:gone: exempted, but the scan reports no unreset state by that name",
    ]);
  });
});
