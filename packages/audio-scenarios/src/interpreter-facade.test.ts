/**
 * The facade's regrowth guard (issue #1514). `ScenarioEngine` is a thin
 * facade: it builds the engine's modules and sequences the calls that cross
 * them, and it holds no state of its own. A feature's state goes in the
 * module that owns its concern, so this test fails on the first field that
 * lands in the facade instead — read two ways, so neither can be fooled
 * alone: the class's declarations in `interpreter.ts`, through the
 * TypeScript compiler API, and the own properties of a built engine.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import type { IEventBus } from "@iracedeck/event-bus";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { _resetAudioScenarios, initializeAudioScenarios } from "./interpreter.js";

/** The module instances the facade builds — one per module of the split. */
const MODULE_INSTANCES = [
  "registry",
  "poolStore",
  "vocab",
  "scripts",
  "expansion",
  "playback",
  "scheduler",
  "triggers",
  "lineEnds",
  "warnings",
];

/** The declared shared bus table (spec Decision 2), which `describeState` reads through `peek`. */
const SHARED_TABLE = ["buses"];

/** The three injected read-only dependencies the facade keeps for its own lines and `describeState`. */
const INJECTED = ["logger", "getActiveVoice", "getFrameOptions"];

/** The session-change clear's unsubscribe, released by `dispose`. */
const LIFECYCLE = ["unsubscribeSessionChanged"];

const ALLOWED = [...MODULE_INSTANCES, ...SHARED_TABLE, ...INJECTED, ...LIFECYCLE].sort();

const SOURCE = fileURLToPath(new URL("./interpreter.ts", import.meta.url));

/**
 * Every field `class ScenarioEngine` declares: property declarations and
 * constructor parameter properties (a parameter with a modifier declares a
 * field too). Methods and accessors are not fields.
 */
function declaredFields(): string[] {
  const file = ts.createSourceFile(SOURCE, readFileSync(SOURCE, "utf8"), ts.ScriptTarget.Latest, true);
  const engine = file.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === "ScenarioEngine",
  );

  if (!engine) throw new Error("class ScenarioEngine not found in interpreter.ts");

  const fields: string[] = [];

  for (const member of engine.members) {
    if (ts.isPropertyDeclaration(member)) fields.push(member.name.getText(file));

    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (ts.getModifiers(parameter)?.length) fields.push(parameter.name.getText(file));
      }
    }
  }

  return fields.sort();
}

afterEach(() => {
  _resetAudioScenarios();
});

describe("ScenarioEngine stays a thin facade", () => {
  it("declares no field beyond the module instances, the shared bus table, the three injected dependencies and the session-change unsubscribe", () => {
    expect(declaredFields()).toEqual(ALLOWED);
  });

  it("a built engine carries exactly those own properties", () => {
    const bus = { subscribe: () => () => {}, unsubscribe: () => {}, publish: () => {} } as unknown as IEventBus;
    const engine = initializeAudioScenarios(bus, {} as IAudioService, {
      clips: [],
      ambientLoop: "",
      ticks: { open: "", close: "" },
    });

    expect(Object.keys(engine).sort()).toEqual(ALLOWED);
  });
});
