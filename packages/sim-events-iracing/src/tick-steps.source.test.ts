/**
 * The step boundary is enforced by a source check (#1559, decision 12): every
 * call a tick function makes itself — not inside a closure it hands a step — is
 * a call through the step boundary (`steps.live`, `.direct`, `.run`, `.value`,
 * `.fallbackValue`, `.requiredValue`) or one of the frame's calls, named in an
 * explicit allow-list. A diff called bare would run outside every boundary, so
 * its throw would cost the rest of the tick again; the check fails until it is
 * wrapped. It also collects the step and value ids, which size the reporter's
 * global cap (decision 7).
 *
 * The parse is the TypeScript compiler's, so a comment, a string or a closure
 * cannot fool it the way a regex over the text could.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { TICK_STEP_KEYS_PER_ID } from "./tick-steps.js";
import { TRANSLATOR_REPORTER_MAX_KEYS } from "./translator.js";

/** The boundary's methods that run a step or a value under a name. */
const STEP_METHODS = new Set(["live", "direct", "run", "value", "fallbackValue", "requiredValue"]);

/**
 * A tick function and the calls of its frame (decision 1): the calls it may
 * make itself outside a step, each with the number of times it makes it.
 * Anything else it calls directly must be a step. The count pins the frame to
 * its calls rather than its names: a further bare `publish(…)` or
 * `self.logger.info(…)` in the step zone would otherwise pass for the frame's,
 * and its throw would escape every step boundary. A frame call added or
 * removed on purpose changes its count here.
 */
type TickFunction = { readonly name: string; readonly frame: Readonly<Record<string, number>> };

/** The translator's tick: `handleTick`'s frame, and the live half's two step functions, which have none. */
const TRANSLATOR_TICK: readonly TickFunction[] = [
  {
    name: "handleTick",
    frame: {
      // F0: the tick's reads before anything else, and the replay skip log's reset.
      "self.controller.getReplayState": 1,
      "self.controller.getSessionInfo": 3,
      isReplayOnlySession: 2,
      // F1: the fresh-connect synthesis, the session identity, the reset and publish, the advance.
      resolveSessionType: 1,
      classifySessionType: 1,
      "self.logger.info": 4,
      publish: 3,
      "Date.now": 3,
      readSessionIdentity: 1,
      resetPerSessionState: 1,
      advanceSessionIdentity: 1,
      // F2: the replay guard's entry teardown and the wipes.
      publishActiveStateTeardown: 1,
      wipeStateForReplay: 2,
      // F3: the live half, whose own steps are checked below, inside the flush's `try`.
      handleLiveSteps: 1,
    },
  },
  { name: "handleLiveSteps", frame: { handleOrderSteps: 1 } },
  { name: "handleOrderSteps", frame: {} },
];

/** The replay recorder's tick: its two reads, the session identity's read, reset and advance, and the replay edges. */
const RECORDER_TICK: readonly TickFunction[] = [
  {
    name: "handleTick",
    frame: {
      "controller.getReplayState": 1,
      "controller.getSessionInfo": 1,
      readSessionIdentity: 1,
      resetReplayRecorderBaselines: 3,
      advanceSessionIdentity: 1,
    },
  },
];

type SourceCheck = {
  /** Calls a tick function makes outside a step beyond its frame's, as `<function>: <callee> …`. */
  readonly problems: string[];
  /** The names every step and value call in the file runs under, deduplicated, in source order. */
  readonly names: string[];
  /** How many step and value calls the tick functions make. */
  readonly stepCalls: number;
};

/** `steps.<method>` or `self.steps.<method>`, when `<method>` runs a step: the method's name, else `undefined`. */
function stepMethod(callee: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const receiver = callee.expression.getText();

  if (receiver !== "steps" && receiver !== "self.steps") return undefined;

  return STEP_METHODS.has(callee.name.text) ? callee.name.text : undefined;
}

/** The file's top-level `const NAME = "literal"` declarations, so a step name held in a constant resolves. */
function stringConstants(file: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isStringLiteral(declaration.initializer)
      ) {
        constants.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }

  return constants;
}

/** A step call's name: its first argument, a string literal or a constant holding one. */
function stepName(call: ts.CallExpression, constants: ReadonlyMap<string, string>): string | undefined {
  const first = call.arguments[0];

  if (first === undefined) return undefined;

  if (ts.isStringLiteral(first)) return first.text;

  if (ts.isIdentifier(first)) return constants.get(first.text);

  return undefined;
}

/**
 * Every call `node` makes itself, not inside a function it defines: a closure is
 * run by whoever it is handed to, so its calls are that caller's, and a closure
 * handed to a step runs inside the boundary.
 */
function directCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];

  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;

    if (ts.isCallExpression(child)) calls.push(child);

    ts.forEachChild(child, visit);
  };

  ts.forEachChild(node, visit);

  return calls;
}

/** Check `source`'s tick functions against the step boundary and collect the names its steps run under. */
function checkTickSource(source: string, tick: readonly TickFunction[]): SourceCheck {
  const file = ts.createSourceFile("tick.ts", source, ts.ScriptTarget.Latest, true);
  const constants = stringConstants(file);
  const problems: string[] = [];
  const names: string[] = [];
  let stepCalls = 0;

  const declared = new Map<string, ts.FunctionDeclaration>();

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      declared.set(statement.name.text, statement);
    }
  }

  for (const { name, frame } of tick) {
    const fn = declared.get(name);

    if (fn?.body === undefined) {
      problems.push(`${name}: no such function`);
      continue;
    }

    const seen = new Map<string, number>();

    for (const call of directCalls(fn.body)) {
      if (stepMethod(call.expression) !== undefined) {
        stepCalls++;

        if (stepName(call, constants) === undefined) {
          problems.push(`${name}: a step whose name is not a literal: ${call.getText().split("\n")[0]}`);
        }

        continue;
      }

      const callee = call.expression.getText();

      if (Object.hasOwn(frame, callee)) seen.set(callee, (seen.get(callee) ?? 0) + 1);
      else problems.push(`${name}: ${callee} is called outside the step boundary`);
    }

    // Exactly the frame's count: one more is a bare call in the step zone, one
    // fewer a frame call gone whose count should go with it.
    for (const [callee, pinned] of Object.entries(frame)) {
      const count = seen.get(callee) ?? 0;

      if (count !== pinned) {
        problems.push(`${name}: ${callee} is called ${count} times outside a step, and its frame pins ${pinned}`);
      }
    }
  }

  // The names: every step call in the file, the tick functions' and any other
  // (the tick listeners' `steps.run`), since the reporter keys them all.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && stepMethod(node.expression) !== undefined) {
      const stepNameText = stepName(node, constants);

      if (stepNameText !== undefined && !names.includes(stepNameText)) names.push(stepNameText);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return { problems, names, stepCalls };
}

const read = (file: string): string => readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");

describe("the step boundary's source check (#1559, decision 12)", () => {
  it("finds every call of the translator's tick inside a step, or in the frame", () => {
    const check = checkTickSource(read("translator.ts"), TRANSLATOR_TICK);

    expect(check.problems).toEqual([]);
    // Not vacuous: the tick's forty-odd steps and a dozen values were seen.
    expect(check.stepCalls).toBeGreaterThan(40);
  });

  it("finds every call of the replay recorder's tick inside a step, or in the frame", () => {
    const check = checkTickSource(read("replay-recorder.ts"), RECORDER_TICK);

    expect(check.problems).toEqual([]);
    expect(check.names).toEqual(["diffReplayLaps", "diffReplayGreens", "diffReplaySessions", "diffReplayIncidents"]);
  });

  it("sizes TRANSLATOR_REPORTER_MAX_KEYS at four sites for every id the shared boundary reports (decision 7)", () => {
    const translator = checkTickSource(read("translator.ts"), TRANSLATOR_TICK).names.map((n) => `translator:${n}`);
    const recorder = checkTickSource(read("replay-recorder.ts"), RECORDER_TICK).names.map(
      (n) => `replay-recorder:${n}`,
    );
    const ids = [...translator, ...recorder];

    expect(new Set(ids).size).toBe(ids.length);
    expect(translator).toContain("translator:onTranslatorTick");
    expect(translator).toContain("translator:resolveCanonicalOrder");
    // Exactly, so a step added or removed moves the cap with it.
    expect(TRANSLATOR_REPORTER_MAX_KEYS).toBe(ids.length * TICK_STEP_KEYS_PER_ID);
  });

  describe("fails on bad input (its positive controls)", () => {
    const tick: readonly TickFunction[] = [{ name: "handleTick", frame: { readFrame: 1 } }];

    it("accepts a tick whose every call is a step or the frame's", () => {
      const source = `
        const LISTENER = "onTick";
        function handleTick(self, telemetry) {
          const info = readFrame();
          steps.live("diffFoo", pending, () => diffFoo(self.state, telemetry, emit));
          const value = steps.value("resolveBar", values, null, () => resolveBar(info));
          if (value) self.steps.run("diffBaz", () => diffBaz(value));
        }
        function notify() { steps.run(LISTENER, listener); }
      `;

      expect(checkTickSource(source, tick)).toEqual({
        problems: [],
        names: ["diffFoo", "resolveBar", "diffBaz", "onTick"],
        stepCalls: 3,
      });
    });

    it("rejects a bare diff call", () => {
      const source = `function handleTick(self, telemetry) {\n  readFrame();\n  diffFoo(self.state, telemetry, emit);\n}`;

      expect(checkTickSource(source, tick).problems).toEqual([
        "handleTick: diffFoo is called outside the step boundary",
      ]);
    });

    it("rejects a frame name called bare once more in the step zone", () => {
      const pinned: readonly TickFunction[] = [{ name: "handleTick", frame: { readFrame: 1, publish: 2 } }];
      const frameOnly =
        "function handleTick(self) {\n  readFrame();\n  publish(self, a);\n  publish(self, b);\n" +
        '  steps.live("diffFoo", pending, () => diffFoo());\n';
      const source = `${frameOnly}  publish(self, { event: "radar.changed", data: {} });\n}`;

      expect(checkTickSource(`${frameOnly}}`, pinned).problems).toEqual([]);
      expect(checkTickSource(source, pinned).problems).toEqual([
        "handleTick: publish is called 3 times outside a step, and its frame pins 2",
      ]);
    });

    it("rejects a frame whose pinned call is gone, so the count cannot go stale", () => {
      const source = `function handleTick(self) {\n  steps.live("diffFoo", pending, () => diffFoo());\n}`;

      expect(checkTickSource(source, tick).problems).toEqual([
        "handleTick: readFrame is called 0 times outside a step, and its frame pins 1",
      ]);
    });

    it("rejects a call made while computing a step's argument outside its closure", () => {
      const source = `function handleTick(self) {\n  readFrame();\n  steps.value("resolveBar", values, resolveFallback(), () => resolveBar());\n}`;

      expect(checkTickSource(source, tick).problems).toEqual([
        "handleTick: resolveFallback is called outside the step boundary",
      ]);
    });

    it("rejects a closure that is run directly rather than handed to a step", () => {
      const source = `function handleTick(self) {\n  readFrame();\n  const run = () => diffFoo(self.state);\n  run();\n}`;

      expect(checkTickSource(source, tick).problems).toEqual(["handleTick: run is called outside the step boundary"]);
    });

    it("rejects a step whose name is not a literal, and a tick function that is missing", () => {
      const source = `function handleTick(self) {\n  readFrame();\n  steps.live(name, pending, () => diffFoo());\n}`;

      expect(checkTickSource(source, [...tick, { name: "handleLiveSteps", frame: {} }]).problems).toEqual([
        "handleTick: a step whose name is not a literal: steps.live(name, pending, () => diffFoo())",
        "handleLiveSteps: no such function",
      ]);
    });
  });
});
