import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  type CameraScanOptions,
  type CameraSend,
  engineCameraReaches,
  exceptionProblems,
  publicMethodsOf,
  readProductionSources,
  scanCameraSends,
  sendKey,
} from "./camera-switch-waiter.single-policy.test-support.js";

/**
 * Every camera switch an action makes goes through the engine's one
 * camera-switch waiter, `requestCameraSwitch` (#1467, Decision 3; the "One
 * camera policy" in this package's `CLAUDE.md`): a switch sent beside it
 * lands in the middle of a position jump, and a lap walk it should interrupt
 * never hears of it. This scans every production source of `iracing-actions`
 * for each camera send — a method call on `getCommands().camera`, a tap of
 * iRacing's camera key bindings, and any use of the camera surface the scan
 * cannot follow — and fails on one that does not run only inside a callback
 * handed to the waiter (#1502). What counts as a send and as "inside" is in
 * the scanner's header, `camera-switch-waiter.single-policy.test-support.ts`.
 *
 * The engine's own camera moves are not the waiter's: the two lap presses
 * make theirs through the injected `camera()` while they hold the cursor. The
 * last block pins that list, so a third engine module reaching the camera
 * fails here too.
 */

const ENGINE_ROOT = import.meta.dirname;
const ACTIONS_ROOT = join(import.meta.dirname, "..", "..", "iracing-actions", "src");
const CAMERA_COMMAND = join(import.meta.dirname, "..", "..", "iracing-sdk", "src", "commands", "CameraCommand.ts");

/**
 * The SDK camera methods that are not a switch, each with why. Every other
 * public method of `CameraCommand` counts as one, so a method the SDK adds is
 * a switch until it is named here. An entry the SDK does not have fails.
 */
const STATE_METHODS: Readonly<Record<string, string>> = {
  setState:
    "Flags on the camera (UI hidden and so on), not a target: Camera Controls' Set Camera State sends it at once, never through the waiter (CLAUDE.md, One camera policy).",
  hideUI: "Sets the camera's UI-hidden flag through setState (Toggle UI Elements): flags, not a switch.",
  showUI: "Clears the camera's UI-hidden flag through setState (Toggle UI Elements): flags, not a switch.",
};

/** The calls that send a key binding: a camera key sent through one is a camera switch. */
const KEY_SENDERS = ["tapBinding", "holdBinding"];

/**
 * The names iRacing's camera key bindings are reached by: Next / Previous Car
 * (`shared/car-cycle-bindings.ts`) and Next / Previous Sub Camera
 * (`camera-controls/sub-camera-bindings.ts`). Each must be exported by one of
 * the scanned files, so a rename cannot leave the keystroke scan blind.
 */
const CAMERA_KEYS = [
  "CAR_CYCLE_BINDING_KEYS",
  "CAR_CYCLE_BINDING_KEY_LIST",
  "carCycleBindingKey",
  "SUB_CAMERA_BINDING_KEYS",
  "SUB_CAMERA_BINDING_KEY_LIST",
  "subCameraBindingKey",
];

/**
 * Camera sends in `iracing-actions` that may go out beside the waiter, by
 * `<file>:<function>`, each with why. None today: Set Camera State is a state
 * method above, not a switch. An entry with no reason, or one that names no
 * send the scan finds outside the waiter, fails.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

/**
 * The engine modules that reach the injected camera (`engineEnv().camera()`),
 * each with why. The list in CLAUDE.md's "One sender" rule; a module missing
 * here or listed here without a reach fails.
 */
const ENGINE_CAMERA_USERS: Readonly<Record<string, string>> = {
  "fastest-lap-press.ts":
    "Jump to Fastest Lap's own camera step, inside the press that holds the cursor: onto the lap's car after the record jump lands, and back to the viewed car.",
  "race-start-press.ts":
    "Jump to Race Start's walk borrows the camera for the pole car and puts it back, inside the press that holds the cursor.",
};

const OPTIONS: CameraScanOptions = {
  stateMethods: new Set(Object.keys(STATE_METHODS)),
  keySenders: new Set(KEY_SENDERS),
  cameraKeys: new Set(CAMERA_KEYS),
};

/** Scans planted sources, one file per entry. */
function scanPlanted(files: Record<string, string>): readonly CameraSend[] {
  return scanCameraSends(new Map(Object.entries(files)), OPTIONS).sends;
}

/** The planted sends outside the waiter, as `<file>:<line> <detail>`. */
function outsideOf(files: Record<string, string>): string[] {
  return scanPlanted(files)
    .filter((send) => !send.inWaiter)
    .map((send) => `${send.file}:${send.line} ${send.detail}`);
}

/** The names a source exports by declaration (`export const`, `export function`). */
function exportedDeclarations(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.ESNext, true);
  const names: string[] = [];

  for (const statement of file.statements) {
    const exported = (ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );

    if (!exported) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }

  return names;
}

const WAITER_IMPORT = `import { requestCameraSwitch } from "@iracedeck/replay-engine";\nimport { getCommands } from "@iracedeck/deck-iracing";\n`;
const OPTS = `{ by: "x", label: "X", name: "x", asked: "x", surface: "the key", stillValid: () => true }`;

describe("camera switches go through the camera-switch waiter (#1502)", () => {
  const sources = readProductionSources(ACTIONS_ROOT);
  const scan = scanCameraSends(sources, OPTIONS);
  const cameraMethods = publicMethodsOf(readFileSync(CAMERA_COMMAND, "utf8"), "CameraCommand");
  const switchMethods = cameraMethods.filter((method) => STATE_METHODS[method] === undefined);

  describe("what it scans for", () => {
    it("names only state methods the SDK's CameraCommand has, each with a reason", () => {
      expect(Object.keys(STATE_METHODS).filter((method) => !cameraMethods.includes(method))).toEqual([]);
      expect(Object.entries(STATE_METHODS).filter(([, reason]) => reason.trim() === "")).toEqual([]);
    });

    it("counts every other camera method as a switch", () => {
      // 8 switches of 11 public methods on 2026-10-31.
      expect(switchMethods).toEqual(expect.arrayContaining(["switchNum", "switchPos", "focusOnLeader", "cycleCar"]));
      expect(switchMethods.length).toBeGreaterThanOrEqual(8);
    });

    it("names camera key bindings the scanned files export", () => {
      const exported = new Set([...sources.values()].flatMap(exportedDeclarations));

      expect(CAMERA_KEYS.filter((name) => !exported.has(name))).toEqual([]);
    });

    it("scans the whole of iracing-actions, not an empty or narrowed glob", () => {
      // 137 production sources, 5 waiter calls, 3 wrappers, 23 camera sends
      // (19 commands, 4 keystrokes) and 3 state calls, on 2026-10-31.
      expect(scan.files.length).toBeGreaterThan(100);
      expect(scan.files).toEqual(
        expect.arrayContaining([
          "actions/camera-controls/camera-controls.ts",
          "actions/race-admin/race-admin.ts",
          "actions/replay-control/replay-control.ts",
          "actions/replay-control/replay-control-camera-car-modes.ts",
          "actions/replay-control/replay-control-track-order-mode.ts",
        ]),
      );
      expect(scan.waiterCalls).toBeGreaterThanOrEqual(5);
      expect(scan.wrappers).toEqual(
        expect.arrayContaining(["requestCarStep(2)", "requestKeyCameraSwitch(3)", "requestSwitch(2)"]),
      );
      expect(scan.stateCalls).toBeGreaterThanOrEqual(3);
    });

    it("finds the real sends inside the waiter: commands of every surface, and the keystrokes", () => {
      const inside = scan.sends.filter((send) => send.inWaiter);
      const commands = inside.filter((send) => send.kind === "command");
      const keystrokes = inside.filter((send) => send.kind === "keystroke");

      expect(inside.length).toBeGreaterThanOrEqual(20);
      expect(commands.length).toBeGreaterThanOrEqual(16);
      expect(keystrokes.length).toBeGreaterThanOrEqual(4);
      expect(new Set(commands.map((send) => send.file))).toEqual(
        new Set([
          "actions/camera-controls/camera-controls.ts",
          "actions/race-admin/race-admin.ts",
          "actions/replay-control/replay-control.ts",
        ]),
      );
      // The dial's Car # / Position switch, reached only through the dial io's `switchToCarNumber`.
      expect(commands.map(sendKey)).toContain("actions/replay-control/replay-control.ts:switchToCarNumber");
      // Camera Controls' Cycle Sub-Camera and Track Order taps, their key reaching `tapBinding` as a parameter.
      expect(keystrokes.map(sendKey)).toContain("actions/camera-controls/camera-controls.ts:tapCycleBinding");
    });

    it("sees only SDK camera methods in the commands it finds", () => {
      const commands = scan.sends.filter((send) => send.kind === "command").map((send) => send.detail);

      expect(commands.filter((method) => !switchMethods.includes(method))).toEqual([]);
    });
  });

  it("every camera send in iracing-actions goes through requestCameraSwitch", () => {
    expect(exceptionProblems(EXCEPTIONS, scan.sends)).toEqual([]);
  });

  describe("positive controls: planted sources through the same scanner", () => {
    it("reports a bare switch outside a waiter callback, and not the same switch inside one", () => {
      const bare = `${WAITER_IMPORT}export function onKeyDown(): void {\n  getCommands().camera.switchNum(12, 0, 0);\n}\n`;
      const inside = `${WAITER_IMPORT}export function onKeyDown(): void {\n  void requestCameraSwitch(() => getCommands().camera.switchNum(12, 0, 0), ${OPTS});\n}\n`;

      expect(outsideOf({ "bare.ts": bare })).toEqual(["bare.ts:4 switchNum"]);
      expect(outsideOf({ "inside.ts": inside })).toEqual([]);
      expect(scanPlanted({ "inside.ts": inside })).toMatchObject([
        { kind: "command", detail: "switchNum", inWaiter: true },
      ]);
    });

    it("reports every way to reach the camera: bound commands, destructured, aliased, through the SDK", () => {
      const planted = [
        "export function a(): void {\n  const c = getCommands();\n  c.camera.switchPos(1, 0, 0);\n}",
        "export function b(): void {\n  const { camera } = getCommands();\n  camera.cycleCar(3, 1);\n}",
        "export function c(): void {\n  const cam = getCommands().camera;\n  cam?.focusOnLeader(0, 0);\n}",
        "export function d(): void {\n  getSDK().commands.camera.switchNum(1, 0, 0);\n}",
        "export function e(): void {\n  const { commands: { camera: cam } } = getSDK();\n  cam.switchNum(1, 0, 0);\n}",
      ].join("\n");

      expect(outsideOf({ "forms.ts": `${WAITER_IMPORT}${planted}\n` })).toEqual([
        "forms.ts:5 switchPos",
        "forms.ts:9 cycleCar",
        "forms.ts:13 focusOnLeader",
        "forms.ts:16 switchNum",
        "forms.ts:20 switchNum",
      ]);
    });

    it("follows a switch into a named method and a wrapper, and reports it once a caller outside the waiter appears", () => {
      const action = (extra: string): string =>
        `${WAITER_IMPORT}export class Action {\n` +
        `  private requestSwitch(name: string, send: () => unknown): void {\n` +
        `    void requestCameraSwitch(send, ${OPTS});\n` +
        `  }\n` +
        `  onKeyDown(): void {\n` +
        `    this.requestSwitch("x", () => this.sendSwitch());\n` +
        `  }\n` +
        `  private sendSwitch(): void {\n` +
        `    getCommands().camera.switchNum(7, 0, 0);\n` +
        `  }\n${extra}}\n`;

      expect(outsideOf({ "action.ts": action("") })).toEqual([]);
      expect(scanCameraSends(new Map([["action.ts", action("")]]), OPTIONS).wrappers).toEqual(["requestSwitch(1)"]);

      const leaked = scanPlanted({ "action.ts": action(`  onDialDown(): void {\n    this.sendSwitch();\n  }\n`) });

      expect(leaked.filter((send) => !send.inWaiter)).toMatchObject([
        { line: 11, detail: "switchNum", context: "sendSwitch", why: expect.stringContaining("action.ts:14") },
      ]);
    });

    it("follows a switch handed through an io object's property, as the dial's Car # mode does", () => {
      const host = `${WAITER_IMPORT}export const io = {\n  switchToCar: (n: number) => getCommands().camera.switchNum(n, 0, 0),\n};\n`;
      const mode = (extra: string): string =>
        `${WAITER_IMPORT}function step(io: { switchToCar(n: number): boolean }): void {\n` +
        `  void requestCameraSwitch(() => switchTo(io, 4), ${OPTS});\n` +
        `}\n` +
        `function switchTo(io: { switchToCar(n: number): boolean }, n: number): void {\n` +
        `  io.switchToCar(n);\n` +
        `}\n${extra}`;
      const direct =
        "export function direct(io: { switchToCar(n: number): boolean }): void {\n  io.switchToCar(1);\n}\n";

      expect(outsideOf({ "host.ts": host, "mode.ts": mode("") })).toEqual([]);
      expect(outsideOf({ "host.ts": host, "mode.ts": mode(direct) })).toEqual(["host.ts:4 switchNum"]);
    });

    it("counts an exported function's imports in other files as its uses", () => {
      const helper = `${WAITER_IMPORT}export function focusCar(n: number): void {\n  getCommands().camera.switchNum(n, 0, 0);\n}\n`;
      const viaWaiter = `${WAITER_IMPORT}import { focusCar } from "./helper.js";\nexport function press(): void {\n  void requestCameraSwitch(() => focusCar(2), ${OPTS});\n}\n`;
      const direct = `import { focusCar } from "./helper.js";\nexport function press(): void {\n  focusCar(2);\n}\n`;

      expect(outsideOf({ "helper.ts": helper, "press.ts": viaWaiter })).toEqual([]);
      expect(outsideOf({ "helper.ts": helper, "press.ts": viaWaiter, "other.ts": direct })).toEqual([
        "helper.ts:4 switchNum",
      ]);
    });

    it("reports a camera key tapped outside the waiter, directly, through a const or through a parameter", () => {
      const keys = `export const CAR_CYCLE_BINDING_KEYS = { next: "replayControlNextCar", previous: "replayControlPrevCar" } as const;\n`;
      const action =
        `${WAITER_IMPORT}import { CAR_CYCLE_BINDING_KEYS } from "./keys.js";\n` +
        `export class Action {\n` +
        `  inside(): void {\n` +
        `    void requestCameraSwitch(() => this.tapBinding(CAR_CYCLE_BINDING_KEYS.next), ${OPTS});\n` +
        `  }\n` +
        `  direct(): void {\n` +
        `    this.tapBinding(CAR_CYCLE_BINDING_KEYS.previous);\n` +
        `  }\n` +
        `  viaConst(direction: "next" | "previous"): void {\n` +
        `    const key = CAR_CYCLE_BINDING_KEYS[direction];\n` +
        `    void this.tapBinding(key);\n` +
        `  }\n` +
        `  cycle(): void {\n` +
        `    this.tapCycle(CAR_CYCLE_BINDING_KEYS.next);\n` +
        `  }\n` +
        `  private tapCycle(settingKey: string): void {\n` +
        `    void this.tapBinding(settingKey);\n` +
        `  }\n` +
        `  other(): void {\n` +
        `    void this.tapBinding("blackBoxNext");\n` +
        `  }\n` +
        `  tapBinding(key: string): Promise<void> {\n` +
        `    return this.keyboard.tapBinding(key);\n` +
        `  }\n` +
        `}\n`;
      const sends = scanPlanted({ "keys.ts": keys, "action.ts": action });

      expect(sends.filter((send) => send.kind === "keystroke").map((send) => `${send.line} ${send.inWaiter}`)).toEqual([
        "6 true",
        "9 false",
        "13 false",
        "19 false",
      ]);
    });

    it("reports a camera surface that escapes, even inside a waiter callback", () => {
      const escapes =
        `${WAITER_IMPORT}export function a(register: (x: unknown) => void): void {\n` +
        `  register(getCommands().camera);\n` +
        `}\n` +
        `export function b(): unknown {\n` +
        `  return getCommands();\n` +
        `}\n` +
        `export function c(): void {\n` +
        `  void requestCameraSwitch(() => {\n` +
        `    const { switchNum } = getCommands().camera;\n` +
        `    switchNum(1, 0, 0);\n` +
        `  }, ${OPTS});\n` +
        `}\n` +
        `export function d(later: (f: unknown) => void): void {\n` +
        `  later(getCommands().camera.switchNum);\n` +
        `}\n`;

      expect(
        scanPlanted({ "escapes.ts": escapes })
          .filter((send) => send.kind === "escape")
          .map((send) => send.line),
      ).toEqual([4, 7, 11, 16]);
    });

    it("ignores comments, strings, state methods and other commands", () => {
      const quiet =
        `${WAITER_IMPORT}// getCommands().camera.switchNum(1, 0, 0);\n` +
        `/** Calls \`getCommands().camera.switchPos\`. */\n` +
        `export function a(): string {\n` +
        `  getCommands().camera.setState(4);\n` +
        `  getCommands().camera.hideUI(0);\n` +
        `  getCommands().pit.fuel(10);\n` +
        `  const settings = { camera: { switchNum: () => 1 } };\n` +
        `  settings.camera.switchNum();\n` +
        `  return "getCommands().camera.switchNum(1, 0, 0)";\n` +
        `}\n`;

      expect(scanPlanted({ "quiet.ts": quiet })).toEqual([]);
    });

    it("recognises the waiter under an import alias", () => {
      const aliased = `import { requestCameraSwitch as whenQuiet } from "@iracedeck/replay-engine";\nexport function a(): void {\n  void whenQuiet(() => getCommands().camera.switchNum(1, 0, 0), {});\n}\n`;

      expect(outsideOf({ "aliased.ts": aliased })).toEqual([]);
      expect(scanPlanted({ "aliased.ts": aliased })).toHaveLength(1);
    });

    it("recognises the waiter through a namespace import of the engine", () => {
      const namespaced = `import * as engine from "@iracedeck/replay-engine";\nimport { getCommands } from "@iracedeck/deck-iracing";\nexport function a(): void {\n  void engine.requestCameraSwitch(() => getCommands().camera.switchNum(1, 0, 0), {});\n}\n`;

      expect(outsideOf({ "namespaced.ts": namespaced })).toEqual([]);
      expect(scanCameraSends(new Map([["namespaced.ts", namespaced]]), OPTIONS).waiterCalls).toBe(1);
    });

    it("takes no call for the waiter that is not the engine's requestCameraSwitch", () => {
      const commands = `import { getCommands } from "@iracedeck/deck-iracing";\n`;
      // A local function of the same name, which runs its callback at once.
      const local =
        `${commands}function requestCameraSwitch(send: () => unknown): void {\n  send();\n}\n` +
        `export function a(): void {\n  requestCameraSwitch(() => getCommands().camera.switchNum(1, 0, 0));\n}\n`;
      // A method of the same name on some object.
      const member = `${commands}export function b(someObj: { requestCameraSwitch(send: () => unknown): void }): void {\n  someObj.requestCameraSwitch(() => getCommands().camera.switchNum(1, 0, 0));\n}\n`;
      // The name imported from somewhere other than the engine.
      const elsewhere = `${commands}import { requestCameraSwitch } from "./my-waiter.js";\nexport function c(): void {\n  void requestCameraSwitch(() => getCommands().camera.switchNum(1, 0, 0));\n}\n`;
      // The engine's namespace, but another of its exports.
      const otherExport = `${commands}import * as engine from "@iracedeck/replay-engine";\nexport function d(): void {\n  void engine.requestSomething(() => getCommands().camera.switchNum(1, 0, 0));\n}\n`;

      expect(outsideOf({ "local.ts": local })).toEqual(["local.ts:6 switchNum"]);
      expect(outsideOf({ "member.ts": member })).toEqual(["member.ts:3 switchNum"]);
      expect(outsideOf({ "elsewhere.ts": elsewhere })).toEqual(["elsewhere.ts:4 switchNum"]);
      expect(outsideOf({ "other.ts": otherExport })).toEqual(["other.ts:4 switchNum"]);

      for (const source of [local, member, elsewhere, otherExport]) {
        expect(scanCameraSends(new Map([["x.ts", source]]), OPTIONS).waiterCalls).toBe(0);
      }
    });
  });

  describe("the exception list", () => {
    const outside: CameraSend = {
      file: "actions/x/x.ts",
      line: 10,
      kind: "command",
      detail: "switchNum",
      context: "press",
      inWaiter: false,
    };
    const inside: CameraSend = { ...outside, line: 20, context: "send", inWaiter: true };

    it("fails on a send outside the waiter that no entry names, and passes once one does", () => {
      expect(exceptionProblems({}, [outside, inside])).toEqual([
        expect.stringContaining("actions/x/x.ts:10 command switchNum in press is not sent through requestCameraSwitch"),
      ]);
      expect(exceptionProblems({ "actions/x/x.ts:press": "Sent at once on purpose." }, [outside, inside])).toEqual([]);
    });

    it("fails on an entry that names no send outside the waiter (stale)", () => {
      expect(exceptionProblems({ "actions/x/x.ts:send": "Gone." }, [inside])).toEqual([
        "stale exception actions/x/x.ts:send: the scan finds no camera send outside the waiter there",
      ]);
    });

    it("fails on an entry with no reason", () => {
      expect(exceptionProblems({ "actions/x/x.ts:press": " " }, [outside])).toEqual([
        "exception actions/x/x.ts:press has no reason",
      ]);
    });
  });

  describe("the engine's own camera moves", () => {
    it("finds a planted reach of the injected camera, and not of the replay (positive control)", () => {
      const planted = new Map([
        ["a.ts", "export function a(): void {\n  engineEnv().camera().switchNum(1, 0, 0);\n}\n"],
        ["b.ts", "export function b(): void {\n  const { camera } = engineEnv();\n  camera().switchNum(1, 0, 0);\n}\n"],
        ["c.ts", "export function c(): void {\n  // engineEnv().camera()\n  engineEnv().replay().pause();\n}\n"],
      ]);

      expect(engineCameraReaches(planted)).toEqual([
        { file: "a.ts", line: 2 },
        { file: "b.ts", line: 2 },
      ]);
    });

    it("only the two lap presses reach the injected camera, each named with a reason", () => {
      const reaches = engineCameraReaches(readProductionSources(ENGINE_ROOT));

      expect([...new Set(reaches.map((reach) => reach.file))].sort()).toEqual(Object.keys(ENGINE_CAMERA_USERS).sort());
      expect(Object.entries(ENGINE_CAMERA_USERS).filter(([, reason]) => reason.trim() === "")).toEqual([]);
      // 3 in fastest-lap-press.ts and 1 bound reach in race-start-press.ts on 2026-10-31.
      expect(reaches.length).toBeGreaterThanOrEqual(4);
    });
  });
});
