import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every dial surface extends the shared base, and every input member reaches
 * its context only through the base's gate (#1589, #1329).
 *
 * `shared/dial-surface-base.ts` owns the per-context map, the lifecycle
 * `ensureContext`, the input-only `inputContext` gate that drops a late input
 * event, the one `forgetContext`, and (on `ReleaseDialSurfaceBase`) the press
 * shapes. Its unit test proves the gate; the shared late-input suite proves
 * the behaviour in each surface's test file. This guard proves the part
 * neither can see: that every surface is on the base at all, declares none of
 * the base's members itself, and opens each `rotate`, `down` and `touchTap`
 * with nothing but the allowed pure prelude and then the gate, acting on its
 * result. It also counts the surfaces against the manifest's `Encoder`
 * actions, so a 19th dial whose surface is named otherwise is not missed, and
 * ties the late-input suite to the same count.
 *
 * It reads source text. `scanSource` blanks comments, and the contents of
 * strings, template literals and regex literals, so brackets inside them do
 * not count; what it does not handle is listed there.
 */

const ACTIONS_DIR = import.meta.dirname;
const MANIFEST = join(ACTIONS_DIR, "../../../iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json");

const RELEASE_BASE = "ReleaseDialSurfaceBase";
const PLAIN_BASE = "DialSurfaceBase";

type SurfaceBase = typeof RELEASE_BASE | typeof PLAIN_BASE;

/** Surfaces that extend `DialSurfaceBase` alone, each with its reason. Every other surface extends `ReleaseDialSurfaceBase`. */
const DIAL_SURFACE_BASE_ONLY: Readonly<Record<string, string>> = {
  "audio-controls/audio-dial-surface.ts":
    "its presses fire at dialDown, so an inherited release pressShape would be wrong for it; its action declares their shape itself (rule 12's named exception)",
};

/** Surfaces with no `touchTap`, each with its reason. Gaining one fails the guard until the entry goes. */
const NO_TOUCH_TAP: Readonly<Record<string, string>> = {
  "audio-controls/audio-dial-surface.ts": "Audio Controls has no touch gesture",
};

type LateInputOptOut = "noUp" | "noTouchTap";

/**
 * The surfaces whose test file may skip a late-input driver, each with the
 * drivers it skips and why. Any other test file that writes `noUp:` or
 * `noTouchTap:` fails, so a surface with gestures cannot opt out unnoticed.
 */
const LATE_INPUT_OPT_OUTS: Readonly<Record<string, { skips: readonly LateInputOptOut[]; reason: string }>> = {
  "audio-controls/audio-dial-surface.ts": { skips: ["noTouchTap"], reason: "it declares no touchTap" },
  "setup-engine/setup-engine-dial-surface.ts": {
    skips: ["noUp", "noTouchTap"],
    reason: "its gesture slots offer only None, so neither a release nor a touch fires anything",
  },
  "setup-hybrid/setup-hybrid-dial-surface.ts": {
    skips: ["noUp", "noTouchTap"],
    reason: "its gesture slots offer only None, so neither a release nor a touch fires anything",
  },
};

const INPUT_MEMBERS = ["rotate", "down", "touchTap"] as const;
type InputMemberName = (typeof INPUT_MEMBERS)[number];

/**
 * Members the base owns: a surface that declares one has stepped around it. An
 * overridden `contextsState` getter would hand the release press shapes a map
 * other than the one `ensureContext` / `forgetContext` write.
 */
const BASE_OWNED_MEMBERS = ["inputContext", "ensureContext", "forgetContext", "contextsState", "contextMap"] as const;

/** The lifecycle members, the only ones that may create a context through `ensureContext`. */
const LIFECYCLE_MEMBERS = ["willAppear", "didReceiveSettings"] as const;
/** Members `ReleaseDialSurfaceBase` owns; a `DialSurfaceBase`-only surface may declare them (rule 12). */
const RELEASE_OWNED_MEMBERS = ["pressShape", "touchShape"] as const;

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

interface ScannedSource {
  /** The source with comments blanked to spaces (newlines kept), so offsets and lines are the original's. */
  code: string;
  /** `code` with the contents of strings, template literals and regex literals blanked too: for structure only. */
  masked: string;
}

const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "void",
  "in",
  "of",
  "delete",
  "new",
  "throw",
  "yield",
  "await",
  "else",
  "do",
]);

function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** Whether a `/` at this point starts a regex literal rather than a division, from what precedes it. */
function regexMayStart(codeSoFar: string): boolean {
  const before = codeSoFar.trimEnd();

  if (before === "") return true;

  const last = before[before.length - 1];

  if (/[A-Za-z0-9_$]/.test(last)) {
    const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0];

    return word !== undefined && KEYWORDS_BEFORE_REGEX.has(word);
  }

  return "(,=:[!&|?{};+-*%<>~^".includes(last);
}

/**
 * Blank comments (for `code`) and literal contents (for `masked`).
 *
 * Handles `//` and block comments, single- and double-quoted strings with
 * escapes, template literals as one opaque literal, and regex literals told
 * from division by the preceding token (with character classes and escapes).
 * Does NOT handle a backtick nested inside a template literal's `${…}` (the
 * outer literal would end early), nor a regex after `)` — `if (x) /re/.test(y)`
 * reads as a division. Neither shape occurs in a dial surface or a plant.
 */
function scanSource(src: string): ScannedSource {
  let code = "";
  let masked = "";
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const j = end === -1 ? src.length : end;
      const b = blank(src.slice(i, j));
      code += b;
      masked += b;
      i = j;
      continue;
    }

    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? src.length : end + 2;
      const b = blank(src.slice(i, j));
      code += b;
      masked += b;
      i = j;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;

      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;

        j++;
      }

      j = Math.min(j + 1, src.length);
      const literal = src.slice(i, j);
      code += literal;
      masked += blank(literal);
      i = j;
      continue;
    }

    if (c === "/" && regexMayStart(code)) {
      let j = i + 1;
      let inClass = false;

      while (j < src.length && src[j] !== "\n") {
        const ch = src[j];

        if (ch === "\\") {
          j += 2;
          continue;
        }

        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;

        j++;
      }

      if (src[j] === "/") {
        j++;

        while (j < src.length && /[a-z]/.test(src[j])) j++;

        const literal = src.slice(i, j);
        code += literal;
        masked += blank(literal);
        i = j;
        continue;
      }
      // No closing slash on the line: a division after all.
    }

    code += c;
    masked += c;
    i++;
  }

  return { code, masked };
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/** The index of the bracket that closes the one at `open`, counting all three kinds, in masked text. */
function matchingClose(masked: string, open: number): number {
  let depth = 0;

  for (let i = open; i < masked.length; i++) {
    if (OPENERS.includes(masked[i])) depth++;
    else if (CLOSERS.includes(masked[i])) {
      depth--;

      if (depth === 0) return i;
    }
  }

  return -1;
}

/** Collapse whitespace the way Prettier's wrapping varies it, so a wrapped call reads as its one-line form. */
function normalise(statement: string): string {
  return statement.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/,\)/g, ")").trim();
}

const BLOCK_STATEMENT = /^(?:if|for|while|switch|try|do|else)\b|^\{/;

/**
 * Split `[start, end)` of a scanned source into its top-level statements,
 * normalised. A statement ends at a `;` outside every bracket, or at the `}`
 * that closes a block statement (`if`, `for`, `while`, `switch`, `try`, `do`, a
 * bare block) unless an `else`, `catch`, `finally` or a `do`'s `while` continues
 * it. Anything after the last terminator is returned as a final statement.
 * Statements that rely on ASI (no `;`) run together; Prettier always writes it.
 */
function splitStatements(scanned: ScannedSource, start: number, end: number): string[] {
  const { code, masked } = scanned;
  const statements: string[] = [];
  let depth = 0;
  let from = start;

  const push = (to: number) => {
    const text = normalise(code.slice(from, to));

    if (text !== "") statements.push(text);

    from = to;
  };

  for (let i = start; i < end; i++) {
    const ch = masked[i];

    if (OPENERS.includes(ch)) {
      depth++;
    } else if (CLOSERS.includes(ch)) {
      depth--;

      if (depth === 0 && ch === "}") {
        const head = normalise(code.slice(from, i));

        if (BLOCK_STATEMENT.test(head)) {
          const rest = masked.slice(i + 1, end).trimStart();
          const continues = /^(?:else|catch|finally)\b/.test(rest) || (/^do\b/.test(head) && /^while\b/.test(rest));

          if (!continues) push(i + 1);
        }
      }
    } else if (ch === ";" && depth === 0) {
      push(i + 1);
    }
  }

  push(end);

  return statements;
}

/** The names of a parameter list's parameters, split at top-level commas (type arguments and arrows included). */
function parameterNames(paramsCode: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < paramsCode.length; i++) {
    const ch = paramsCode[i];

    if (ch === "=" && paramsCode[i + 1] === ">") {
      current += "=>";
      i++;
      continue;
    }

    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;

    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  parts.push(current);

  return parts.map((p) => /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? "").filter((name) => name !== "");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------

/** The heritage of the file's one `*DialSurface` class, or a problem. */
function surfaceClass(text: string): { name: string; heritage: string } | { problem: string } {
  const { code, masked } = scanSource(text);
  const found = [
    ...masked.matchAll(/^(?:export[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*DialSurface)\b/gm),
  ];

  if (found.length !== 1) {
    return { problem: `expected exactly one *DialSurface class, found ${found.length}` };
  }

  const match = found[0];
  const after = match.index + match[0].length;
  const bodyOpen = masked.indexOf("{", after);

  return { name: match[1], heritage: normalise(code.slice(after, bodyOpen === -1 ? undefined : bodyOpen)) };
}

/** Which base the class extends, read from its heritage; undefined when it is neither. */
function extendedBase(text: string): SurfaceBase | undefined {
  const cls = surfaceClass(text);

  if ("problem" in cls) return undefined;

  if (/^extends ReleaseDialSurfaceBase ?</.test(cls.heritage)) return RELEASE_BASE;

  if (/^extends DialSurfaceBase ?</.test(cls.heritage)) return PLAIN_BASE;

  return undefined;
}

/** The class must extend `ReleaseDialSurfaceBase<`, or `DialSurfaceBase<` when the file is allow-listed for it. */
function classProblems(file: string, text: string): string[] {
  const cls = surfaceClass(text);

  if ("problem" in cls) return [cls.problem];

  const base = extendedBase(text);
  const plainAllowed = file in DIAL_SURFACE_BASE_ONLY;

  if (base === RELEASE_BASE && !plainAllowed) return [];

  if (base === PLAIN_BASE && plainAllowed) return [];

  if (base === RELEASE_BASE && plainAllowed) {
    return [`${cls.name} extends ${RELEASE_BASE}, but is allow-listed for ${PLAIN_BASE} alone: drop the stale entry`];
  }

  const expected = plainAllowed ? PLAIN_BASE : RELEASE_BASE;

  return [`${cls.name} must extend ${expected}<…>; its heritage is "${cls.heritage || "(none)"}"`];
}

/** A member declared at class-member indentation: modifiers, then the name, then its parameters or type. */
function declaresMember(masked: string, name: string): boolean {
  return new RegExp(
    `^ {2}(?:(?:public|protected|private|override|async|static|readonly|abstract|declare)[ \\t]+)*(?:get[ \\t]+|set[ \\t]+)?${name}[ \\t]*[(<=:!?]`,
    "m",
  ).test(masked);
}

/** No member the base owns, no direct use of the gate's function, and no press shapes on a release subclass. */
function memberProblems(text: string): string[] {
  const { masked } = scanSource(text);
  const problems: string[] = [];
  // A surface on neither base is judged as a release subclass: the strictest reading.
  const base = extendedBase(text) ?? RELEASE_BASE;

  for (const name of BASE_OWNED_MEMBERS) {
    if (declaresMember(masked, name)) problems.push(`declares ${name}, which the base owns`);
  }

  if (base === RELEASE_BASE) {
    for (const name of RELEASE_OWNED_MEMBERS) {
      if (declaresMember(masked, name)) problems.push(`declares ${name}, which ${RELEASE_BASE} owns`);
    }
  }

  if (/\bhasDialInputContext\b/.test(masked)) {
    problems.push("names hasDialInputContext: the gate is called through the base's inputContext only");
  }

  return problems;
}

interface InputMember {
  line: number;
  /** The parameter names, in order. */
  params: string[];
  /** The body's top-level statements, comments stripped and whitespace normalised; undefined for a bodiless declaration. */
  statements: string[] | undefined;
  /** The body's code, comments stripped. */
  bodyCode: string;
  /** The offsets of the body's `{` and `}` in the source (both -1 for a bodiless declaration). */
  bodyOpen: number;
  bodyClose: number;
}

/** The input members of a surface: see {@link classMembers}. */
function inputMembers(text: string, name: InputMemberName): InputMember[] {
  return classMembers(text, name);
}

/**
 * Every method declaration of `name` at member indentation, read to its body
 * however many lines the signature spans: the parameter list to its matching
 * `)`, then any return type to the first `{` (a body) or `;` (none) outside it.
 */
function classMembers(text: string, name: string): InputMember[] {
  const scanned = scanSource(text);
  const { code, masked } = scanned;
  const pattern = new RegExp(
    `^ {2}(?:(?:public|protected|private|override|async)[ \\t]+)*${name}[ \\t]*(?:<[^>(]*>)?[ \\t]*\\(`,
    "gm",
  );
  const members: InputMember[] = [];

  for (const match of masked.matchAll(pattern)) {
    const paramsOpen = match.index + match[0].length - 1;
    const paramsClose = matchingClose(masked, paramsOpen);

    if (paramsClose === -1) continue;

    const params = parameterNames(code.slice(paramsOpen + 1, paramsClose));
    let bodyOpen = -1;

    for (let i = paramsClose + 1; i < masked.length; i++) {
      if (masked[i] === "{") {
        bodyOpen = i;
        break;
      }

      if (masked[i] === ";") break;
    }

    if (bodyOpen === -1) {
      members.push({
        line: lineOf(text, match.index),
        params,
        statements: undefined,
        bodyCode: "",
        bodyOpen: -1,
        bodyClose: -1,
      });
      continue;
    }

    const bodyClose = matchingClose(masked, bodyOpen);
    const end = bodyClose === -1 ? masked.length : bodyClose;

    members.push({
      line: lineOf(text, match.index),
      params,
      statements: splitStatements(scanned, bodyOpen + 1, end),
      bodyCode: code.slice(bodyOpen + 1, end),
      bodyOpen,
      bodyClose: end,
    });
  }

  return members;
}

/**
 * A context is created only by a lifecycle event. Every `ensureContext` token in
 * the code (comments and strings aside) must lie inside the body of
 * `willAppear` or `didReceiveSettings`, so an input path cannot reach it
 * through a helper; no `ensureContext` / `willAppear` / `didReceiveSettings`
 * may be named in a string (a computed `this["…"]`); and the surface never
 * reaches its own lifecycle members through `this`, which would let an input
 * path run them.
 */
function lifecycleProblems(text: string): string[] {
  const { code, masked } = scanSource(text);
  const lifecycleBodies = LIFECYCLE_MEMBERS.flatMap((name) => classMembers(text, name)).filter(
    (m) => m.bodyOpen !== -1,
  );
  const problems: string[] = [];

  for (const match of masked.matchAll(/\bensureContext\b/g)) {
    const inside = lifecycleBodies.some((m) => match.index > m.bodyOpen && match.index < m.bodyClose);

    if (!inside) {
      problems.push(
        `names ensureContext at line ${lineOf(text, match.index)}, outside willAppear and didReceiveSettings: only a lifecycle event may create a context`,
      );
    }
  }

  for (const match of code.matchAll(/(["'`])(ensureContext|willAppear|didReceiveSettings)\1/g)) {
    problems.push(`names ${match[2]} in a string at line ${lineOf(text, match.index)}`);
  }

  for (const match of masked.matchAll(/\bthis\s*\.\s*(willAppear|didReceiveSettings)\b/g)) {
    problems.push(
      `reaches this.${match[1]} at line ${lineOf(text, match.index)}: a lifecycle member is the host's to call, never the surface's`,
    );
  }

  return problems;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The member's body must open with the allowed prelude, each statement
 * optional but in this order — the flag test, the gesture read from the
 * event's settings parameter, the `none` test — and then exactly one gate
 * form naming this member's event, with its result acted on. `this.ensureContext(`
 * may appear nowhere in it.
 */
function gateProblems(member: InputMember, event: InputMemberName): string[] {
  if (member.statements === undefined) return [`${event} (line ${member.line}) has no body`];

  const problems: string[] = [];
  const settings = member.params[1];

  if (member.params[0] !== "action" || settings === undefined) {
    return [
      `${event} (line ${member.line}) must take (action, <settings>, …); its parameters are (${member.params.join(", ")})`,
    ];
  }

  if (/\bthis\s*\.\s*ensureContext\s*\(/.test(member.bodyCode)) {
    problems.push(
      `${event} (line ${member.line}) calls this.ensureContext(: an input event must never create a context`,
    );
  }

  const s = escapeRegExp(settings);
  const prelude = [
    /^if \(!__FEATURE_DIAL_EXTENDED_GESTURES__\) return;$/,
    new RegExp(`^const gesture = hold \\? (${s}|${s}\\.dial)\\.longTouchAction : \\1\\.tapAction;$`),
    /^if \(gesture === "none"\) return;$/,
  ];
  const statements = member.statements;
  let at = 0;

  for (const allowed of prelude) {
    if (at < statements.length && allowed.test(statements[at])) at++;
  }

  const gateCall = `this.inputContext(action, ${settings}, "${event}")`;
  const first = statements[at];
  const second = statements[at + 1];

  if (first === `const ctx = ${gateCall};`) {
    if (second !== "if (!ctx) return;") {
      problems.push(
        `${event} (line ${member.line}): "const ctx = ${gateCall};" must be followed directly by "if (!ctx) return;", found "${second ?? "(nothing)"}"`,
      );
    }
  } else if (first !== `if (!${gateCall}) return;`) {
    problems.push(
      `${event} (line ${member.line}): after the allowed prelude the next statement must be the gate ` +
        `"const ctx = ${gateCall};" or "if (!${gateCall}) return;", found "${first ?? "(nothing)"}"`,
    );
  }

  return problems;
}

/** The test file beside a surface imports `describeLateInput` from the shared suite and calls it exactly once. */
function lateInputProblems(testText: string): string[] {
  const { code, masked } = scanSource(testText);
  const problems: string[] = [];

  if (
    !/import\s*\{[^}]*\bdescribeLateInput\b[^}]*\}\s*from\s*["'][^"']*\/shared\/dial-late-input\.test-support\.js["']/.test(
      code,
    )
  ) {
    problems.push("does not import describeLateInput from shared/dial-late-input.test-support.js");
  }

  const calls = [...masked.matchAll(/\bdescribeLateInput\s*\(/g)].length;

  if (calls !== 1) problems.push(`calls describeLateInput ${calls} times, not once`);

  return problems;
}

/**
 * A late-input driver the test file skips must be one its surface is
 * allow-listed to skip. Any `noUp` / `noTouchTap` identifier in the code (a
 * key, a shorthand property, a variable) or the name quoted in a string (a
 * computed key) counts as a skip, whatever form the opt-out takes.
 */
function optOutProblems(testText: string, allowed: readonly LateInputOptOut[]): string[] {
  const { code, masked } = scanSource(testText);

  return (["noUp", "noTouchTap"] as const)
    .filter(
      (key) =>
        (new RegExp(`\\b${key}\\b`).test(masked) || new RegExp(`(["'\`])${key}\\1`).test(code)) &&
        !allowed.includes(key),
    )
    .map((key) => `skips a late-input driver with ${key}, but its surface has no LATE_INPUT_OPT_OUTS entry for it`);
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

interface SurfaceSource {
  file: string;
  text: string;
  testFile: string;
  testText: string | undefined;
}

function dialSurfaces(): SurfaceSource[] {
  const found: SurfaceSource[] = [];

  for (const dir of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    for (const file of readdirSync(join(ACTIONS_DIR, dir.name))) {
      if (!file.endsWith("-dial-surface.ts")) continue;

      const testName = file.replace(/\.ts$/, ".test.ts");
      const testPath = join(ACTIONS_DIR, dir.name, testName);

      found.push({
        file: `${dir.name}/${file}`,
        text: readFileSync(join(ACTIONS_DIR, dir.name, file), "utf8"),
        testFile: `${dir.name}/${testName}`,
        testText: existsSync(testPath) ? readFileSync(testPath, "utf8") : undefined,
      });
    }
  }

  return found;
}

function encoderUuids(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    Actions: { UUID: string; Controllers?: string[] }[];
  };

  return manifest.Actions.filter((a) => a.Controllers?.includes("Encoder")).map((a) => a.UUID);
}

/** The action folders whose non-test sources declare this UUID constant (`export const X_UUID = "…"`), as `press-shape-coverage.test.ts` finds them. */
function foldersDeclaringUuid(uuid: string): string[] {
  const pattern = new RegExp(`_UUID\\s*=\\s*"${escapeRegExp(uuid)}"`);
  const folders = new Set<string>();

  for (const dir of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    for (const file of readdirSync(join(ACTIONS_DIR, dir.name))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.includes(".test-")) continue;

      if (pattern.test(readFileSync(join(ACTIONS_DIR, dir.name, file), "utf8"))) folders.add(dir.name);
    }
  }

  return [...folders];
}

/**
 * The surfaces are tied to the encoders by folder, not only by count: each
 * folder that declares an `Encoder` action holds a `*-dial-surface.ts`, and
 * each folder holding one declares an `Encoder` action. Without it, a new dial
 * whose surface is named otherwise plus a stray surface elsewhere would keep
 * both counts equal.
 */
function encoderFolderProblem(
  folder: string,
  encoderFolders: ReadonlySet<string>,
  surfaceFolders: ReadonlySet<string>,
): string | undefined {
  if (encoderFolders.has(folder) && !surfaceFolders.has(folder)) {
    return `${folder}/ declares an Encoder action but holds no *-dial-surface.ts`;
  }

  if (surfaceFolders.has(folder) && !encoderFolders.has(folder)) {
    return `${folder}/ holds a *-dial-surface.ts but declares no Encoder action in the Elgato manifest`;
  }

  return undefined;
}

const surfaces = dialSurfaces();
const encoders = encoderUuids();
const encoderFolderMatches = encoders.map((uuid) => [uuid, foldersDeclaringUuid(uuid)] as const);
const encoderFolders = new Set(encoderFolderMatches.flatMap(([, folders]) => folders));
const surfaceFolders = new Set(surfaces.map((s) => s.file.split("/")[0]));

describe("dial surface base coverage (#1589)", () => {
  it("finds one dial surface per Encoder action in the Elgato manifest", () => {
    // A floor first, so a moved manifest or a renamed controller cannot read as
    // "0 surfaces for 0 encoders".
    expect(encoders.length).toBeGreaterThanOrEqual(18);
    expect(surfaces.map((s) => s.file)).toHaveLength(encoders.length);
  });

  it.each(encoderFolderMatches)("finds the one action folder that declares %s", (uuid, folders) => {
    expect(folders, `the action folders declaring ${uuid}`).toHaveLength(1);
  });

  it.each([...new Set([...encoderFolders, ...surfaceFolders])].sort())(
    "pairs %s/ with an Encoder action and a dial surface",
    (folder) => {
      expect(encoderFolderProblem(folder, encoderFolders, surfaceFolders)).toBeUndefined();
    },
  );

  it("names only surfaces that exist in its allow-lists", () => {
    const files = surfaces.map((s) => s.file);

    for (const file of [
      ...Object.keys(DIAL_SURFACE_BASE_ONLY),
      ...Object.keys(NO_TOUCH_TAP),
      ...Object.keys(LATE_INPUT_OPT_OUTS),
    ]) {
      expect(files, `allow-list entry ${file} names no surface`).toContain(file);
    }
  });

  describe.each(surfaces.map((s) => [s.file, s] as const))("%s", (_file, surface) => {
    it("extends the base", () => {
      expect(classProblems(surface.file, surface.text)).toEqual([]);
    });

    it("declares none of the base's members and never names the gate function", () => {
      expect(memberProblems(surface.text)).toEqual([]);
    });

    it("creates a context only from willAppear and didReceiveSettings", () => {
      expect(lifecycleProblems(surface.text)).toEqual([]);
    });

    it.each(INPUT_MEMBERS)("%s reaches its context only through the gate", (name) => {
      const members = inputMembers(surface.text, name);

      if (name === "touchTap" && surface.file in NO_TOUCH_TAP) {
        expect(members, `${surface.file} gained a touchTap: drop its NO_TOUCH_TAP entry`).toHaveLength(0);

        return;
      }

      expect(
        members,
        `${surface.file} declares ${name} ${members.length} times as a method at member indentation (an arrow-function property is not found)`,
      ).toHaveLength(1);
      expect(gateProblems(members[0], name)).toEqual([]);
    });

    it("runs the shared late-input suite in its test file", () => {
      expect(surface.testText, `${surface.testFile} is missing`).toBeDefined();
      expect(lateInputProblems(surface.testText ?? "")).toEqual([]);
    });

    it("skips only the late-input drivers its surface is allow-listed to skip", () => {
      expect(optOutProblems(surface.testText ?? "", LATE_INPUT_OPT_OUTS[surface.file]?.skips ?? [])).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// The positive control: every predicate fails on a planted defect
// ---------------------------------------------------------------------------

const PLANT_FILE = "plant/plant-dial-surface.ts";

function plant(heritage: string, ...members: string[]): string {
  return [
    `import { type DialGestures, gestureSlots, ReleaseDialSurfaceBase } from "../../shared/dial-surface-base.js";`,
    "",
    `export class PlantDialSurface ${heritage}{`,
    "  // rotate(action: IDeckActionContext, dial: DialSettings) { this.ensureContext(action, dial); }",
    "  /* pressShape(action: IDeckActionContext, dial: DialSettings) {} */",
    members.join("\n\n"),
    "}",
    "",
  ].join("\n");
}

const RELEASE = "extends ReleaseDialSurfaceBase<PlantContext, DialSettings> ";
const PLAIN = "extends DialSurfaceBase<PlantContext, DialSettings> ";

const ROTATE_OK = `  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number): Promise<void> {
    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    await this.turn(ctx, ticks);
  }`;

/** The `const ctx` form wrapped across lines the way Prettier wraps a long call, with a comment ahead of it. */
const DOWN_OK = `  down(action: IDeckActionContext, dial: DialSettings): void {
    // A comment before the gate is not a statement.
    const ctx = this.inputContext(
      action,
      dial,
      "down",
    );

    if (!ctx) return;

    ctx.pressStart = Date.now();
  }`;

/** The full prelude, then the `if (!this.inputContext(…))` form. */
const TOUCH_TAP_OK = `  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    if (!this.inputContext(action, dial, "touchTap")) return;

    if (hold) {
      this.host.logger.info("long touch; }");
    } else {
      this.host.logger.info("tap");
    }

    await this.doGesture(gesture);
  }`;

const OTHER_MEMBERS = `  protected override dialGestures(_ctx: PlantContext, dial: DialSettings): DialGestures {
    return gestureSlots(dial);
  }`;

/** The lifecycle members, the one place `ensureContext` may be named. */
const LIFECYCLE_OK = `  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    await this.render(ctx);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    await this.render(this.ensureContext(action, dial));
  }`;

const MIGRATED = plant(RELEASE, LIFECYCLE_OK, ROTATE_OK, DOWN_OK, TOUCH_TAP_OK, OTHER_MEMBERS);

/** A rotate that passes the gate and then does `work`. */
function rotateAfterGate(work: string): string {
  return rotateWith(`    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    ${work}`);
}

function rotateWith(
  body: string,
  signature = "  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number): Promise<void> {",
): string {
  return `${signature}\n${body}\n  }`;
}

function rotateGateProblems(source: string): string[] {
  const members = inputMembers(source, "rotate");

  // Found and judged, never skipped: a missed member would read as a pass.
  expect(members).toHaveLength(1);

  return gateProblems(members[0], "rotate");
}

const LATE_INPUT_TEST_OK = `import { describe } from "vitest";

import { describeLateInput } from "../../shared/dial-late-input.test-support.js";

describe("PlantDialSurface", () => {
  describeLateInput({ appear, disappear, rotate, down, up, touchTap, contexts, sent });
});
`;

describe("dial surface base coverage: positive control", () => {
  it("passes a migrated surface with both gate forms and the full prelude", () => {
    expect(classProblems(PLANT_FILE, MIGRATED)).toEqual([]);
    expect(memberProblems(MIGRATED)).toEqual([]);

    for (const name of INPUT_MEMBERS) {
      const members = inputMembers(MIGRATED, name);

      expect(members, name).toHaveLength(1);
      expect(gateProblems(members[0], name), name).toEqual([]);
    }
  });

  it("splits the body into its statements, blocks and wrapped calls included", () => {
    const [touchTap] = inputMembers(MIGRATED, "touchTap");

    expect(touchTap.statements).toEqual([
      "if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;",
      "const gesture = hold ? dial.longTouchAction : dial.tapAction;",
      'if (gesture === "none") return;',
      'if (!this.inputContext(action, dial, "touchTap")) return;',
      'if (hold) { this.host.logger.info("long touch; }"); } else { this.host.logger.info("tap"); }',
      "await this.doGesture(gesture);",
    ]);
    expect(inputMembers(MIGRATED, "down")[0].statements?.[0]).toBe(
      'const ctx = this.inputContext(action, dial, "down");',
    );
  });

  it("flags a class with no extends, or the wrong base", () => {
    expect(classProblems(PLANT_FILE, plant("", ROTATE_OK, DOWN_OK, TOUCH_TAP_OK))).not.toEqual([]);
    expect(classProblems(PLANT_FILE, plant("extends SomethingElse<PlantContext> ", ROTATE_OK))).not.toEqual([]);
    // DialSurfaceBase alone is for the allow-listed surface only, and that one may not drift onto the release base.
    expect(classProblems(PLANT_FILE, plant(PLAIN, ROTATE_OK))).not.toEqual([]);
    expect(classProblems("audio-controls/audio-dial-surface.ts", plant(PLAIN, ROTATE_OK))).toEqual([]);
    expect(classProblems("audio-controls/audio-dial-surface.ts", plant(RELEASE, ROTATE_OK))).not.toEqual([]);
    // A file with no surface class at all.
    expect(classProblems(PLANT_FILE, "export const x = 1;\n")).not.toEqual([]);
  });

  it("flags a member the base owns, and a direct use of the gate function", () => {
    const inputContext = `  protected inputContext(action: IDeckActionContext, dial: DialSettings, event: DialInputEvent) {
    return undefined;
  }`;
    const ensureContext = `  private ensureContext(action: IDeckActionContext, dial: DialSettings): PlantContext {
    return this.make(action, dial);
  }`;
    const forgetContext = `  protected override forgetContext(actionId: string): void {
    this.map.delete(actionId);
  }`;

    expect(memberProblems(plant(RELEASE, ROTATE_OK, inputContext))).not.toEqual([]);
    expect(memberProblems(plant(RELEASE, ROTATE_OK, ensureContext))).not.toEqual([]);
    expect(memberProblems(plant(RELEASE, ROTATE_OK, forgetContext))).not.toEqual([]);
    expect(
      memberProblems(`import { hasDialInputContext } from "../../shared/dial-context.js";\n${MIGRATED}`),
    ).not.toEqual([]);
    // Calling the inherited members is what every surface does, and is not declaring them.
    expect(memberProblems(MIGRATED)).toEqual([]);
  });

  it("flags pressShape / touchShape on a ReleaseDialSurfaceBase subclass, and allows them on a DialSurfaceBase-only one", () => {
    const pressShape = `  pressShape(action: IDeckActionContext, dial: DialSettings): PressShape {
    return { kind: "release" };
  }`;
    const touchShape = `  override touchShape(action: IDeckActionContext, dial: DialSettings, hold: boolean): PressShape {
    return { kind: "none" };
  }`;

    expect(memberProblems(plant(RELEASE, ROTATE_OK, pressShape))).not.toEqual([]);
    expect(memberProblems(plant(RELEASE, ROTATE_OK, touchShape))).not.toEqual([]);
    expect(memberProblems(plant(PLAIN, ROTATE_OK, pressShape, touchShape))).toEqual([]);
  });

  it("flags a rotate that calls this.ensureContext( first, or anywhere", () => {
    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(`    const ctx = this.ensureContext(action, dial);

    await this.turn(ctx, ticks);`),
        ),
      ),
    ).not.toEqual([]);
    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(`    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    await this.turn(this.ensureContext(action, dial), ticks);`),
        ),
      ),
    ).not.toEqual([]);
  });

  it("flags a module call before the gate, which a first-this. test would miss", () => {
    for (const call of ["renderSomething(action);", "void flush();"]) {
      expect(
        rotateGateProblems(
          plant(
            RELEASE,
            rotateWith(`    ${call}

    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;`),
          ),
        ),
        call,
      ).not.toEqual([]);
    }
  });

  it("flags an ignored gate result, and a const gate not followed directly by its return", () => {
    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(`    this.inputContext(action, dial, "rotate");

    await this.host.tapBinding("key");`),
        ),
      ),
    ).not.toEqual([]);
    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(`    const ctx = this.inputContext(action, dial, "rotate");

    await this.host.tapBinding("key");

    if (!ctx) return;`),
        ),
      ),
    ).not.toEqual([]);
  });

  it("flags a gate that names another member's event", () => {
    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(`    const ctx = this.inputContext(action, dial, "down");

    if (!ctx) return;`),
        ),
      ),
    ).not.toEqual([]);
  });

  it("flags a prelude out of order, or one read from another source than the event's settings", () => {
    const outOfOrder = `  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    if (!this.inputContext(action, dial, "touchTap")) return;
  }`;
    const fromElsewhere = `  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    const gesture = hold ? this.cached.longTouchAction : this.cached.tapAction;

    if (!this.inputContext(action, dial, "touchTap")) return;
  }`;

    for (const member of [outOfOrder, fromElsewhere]) {
      const [found] = inputMembers(plant(RELEASE, member), "touchTap");

      expect(gateProblems(found, "touchTap")).not.toEqual([]);
    }
  });

  it("finds a rotate whose signature spans four lines, and judges it", () => {
    const signature = `  async rotate(
    action: IDeckActionContext,
    dial: DialSettings,
    ticks: number,
  ): Promise<void> {`;

    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(
            `    renderSomething(action);

    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;`,
            signature,
          ),
        ),
      ),
    ).not.toEqual([]);
    expect(
      rotateGateProblems(
        plant(
          RELEASE,
          rotateWith(
            `    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;`,
            signature,
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a member in a comment or a string, and finds no member at statement indentation", () => {
    // Every plant carries a commented-out `rotate(` and `pressShape(` at member indentation; only the real member is found.
    expect(inputMembers(MIGRATED, "rotate")).toHaveLength(1);
    expect(inputMembers(plant(RELEASE, `  label = "\n  rotate(action, dial) {";`), "rotate")).toHaveLength(0);
    expect(inputMembers("    rotate(action, dial);\n", "rotate")).toHaveLength(0);
  });

  it("flags a surface test file without a single describeLateInput call", () => {
    expect(lateInputProblems(LATE_INPUT_TEST_OK)).toEqual([]);
    expect(
      lateInputProblems(`import { describe } from "vitest";\n\ndescribe("PlantDialSurface", () => {});\n`),
    ).not.toEqual([]);
    // Imported but never called, or the call only in a comment.
    expect(
      lateInputProblems(LATE_INPUT_TEST_OK.replace(/ {2}describeLateInput\(/, "  // describeLateInput(")),
    ).not.toEqual([]);
    // Called twice.
    expect(lateInputProblems(LATE_INPUT_TEST_OK.replace(/^\}\);$/m, "  describeLateInput({});\n});"))).not.toEqual([]);
  });

  it("flags a skipped late-input driver its surface is not allow-listed to skip", () => {
    const skipping = LATE_INPUT_TEST_OK.replace(/ {2}describeLateInput\(\{/, '  describeLateInput({ noTouchTap: "x",');

    expect(optOutProblems(LATE_INPUT_TEST_OK, [])).toEqual([]);
    expect(optOutProblems(skipping, [])).not.toEqual([]);
    expect(optOutProblems(skipping, ["noTouchTap"])).toEqual([]);
    expect(optOutProblems(skipping.replace("noTouchTap", "noUp"), ["noTouchTap"])).not.toEqual([]);
  });

  it("counts a shorthand, computed or quoted opt-out key as a skip", () => {
    const shorthand = LATE_INPUT_TEST_OK.replace(
      / {2}describeLateInput\(\{/,
      '  const noUp = "no release gesture";\n  describeLateInput({ noUp, downLanded,',
    );
    const computed = LATE_INPUT_TEST_OK.replace(
      / {2}describeLateInput\(\{/,
      '  describeLateInput({ ["noTouchTap"]: "x",',
    );
    const backtick = LATE_INPUT_TEST_OK.replace(/ {2}describeLateInput\(\{/, "  describeLateInput({ [`noUp`]: 'x',");

    for (const text of [shorthand, computed, backtick]) {
      expect(optOutProblems(text, [])).not.toEqual([]);
    }

    expect(optOutProblems(shorthand, ["noUp"])).toEqual([]);
    expect(optOutProblems(computed, ["noTouchTap"])).toEqual([]);
  });

  it("flags ensureContext reached outside willAppear and didReceiveSettings", () => {
    const helper = `  private ctxFor(action: IDeckActionContext, dial: DialSettings): PlantContext {
    return this.ensureContext(action, dial);
  }`;
    const computedHelper = `  private ctxFor(action: IDeckActionContext, dial: DialSettings): PlantContext {
    return this["ensureContext"](action, dial);
  }`;

    expect(lifecycleProblems(MIGRATED)).toEqual([]);
    // A rotate that passes its gate, then reaches ensureContext through a helper.
    const throughHelper = plant(RELEASE, LIFECYCLE_OK, rotateAfterGate("await this.ctxFor(action, dial);"), helper);

    expect(rotateGateProblems(throughHelper)).toEqual([]);
    expect(lifecycleProblems(throughHelper)).not.toEqual([]);
    expect(
      lifecycleProblems(
        plant(RELEASE, LIFECYCLE_OK, rotateAfterGate("void this.ctxFor(action, dial);"), computedHelper),
      ),
    ).not.toEqual([]);

    // Or by running a lifecycle member itself.
    for (const call of ["await this.didReceiveSettings(action, dial);", "await this.willAppear(action, dial);"]) {
      expect(lifecycleProblems(plant(RELEASE, LIFECYCLE_OK, rotateAfterGate(call))), call).not.toEqual([]);
    }
  });

  it("flags an overridden contextsState getter, and a contextMap of the surface's own", () => {
    const getter = `  protected override get contextsState(): ReadonlyMap<string, PlantContext> {
    return this.mine;
  }`;
    const field = "  private readonly contextMap = new Map<string, PlantContext>();";

    expect(memberProblems(plant(RELEASE, ROTATE_OK, getter))).not.toEqual([]);
    expect(memberProblems(plant(RELEASE, ROTATE_OK, field))).not.toEqual([]);
    // Reading the inherited getter is what every surface does.
    expect(memberProblems(plant(RELEASE, rotateAfterGate("this.contextsState.get(action.id);")))).toEqual([]);
  });

  it("ties each surface to an Encoder action by folder, not only by count", () => {
    // A new dial whose surface is named otherwise, plus a stray surface elsewhere: both counts stay at two.
    const encoderSet = new Set(["setup-aero", "new-dial"]);
    const surfaceSet = new Set(["setup-aero", "stray"]);

    expect(encoderSet.size).toBe(surfaceSet.size);
    expect(encoderFolderProblem("setup-aero", encoderSet, surfaceSet)).toBeUndefined();
    expect(encoderFolderProblem("new-dial", encoderSet, surfaceSet)).toContain("new-dial/");
    expect(encoderFolderProblem("stray", encoderSet, surfaceSet)).toContain("stray/");
  });
});
