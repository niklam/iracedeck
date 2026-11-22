/**
 * The pools a voice's script reaches through vars that DECLARED what they
 * draw (`defineVar`'s `draws`, issue #1718) — one reading, shared by
 * `lint:pack` (`lint-pack.ts`) and the first-party completeness test
 * (`catalog/pit-crew/bundled-scripts.test.ts`), so the linter and the test
 * that holds the bundled voices cannot disagree about which lines a script
 * asks a pack to record.
 *
 * A declared pool is reached only through its var — the script says
 * `{{spotterClip}}`, never `pool:spotter/car-left` — so no walk of the
 * script's steps can see it. What decides whether the script reaches it is
 * WHERE the script names the var:
 *
 * - An unscoped draw (no `contracts`) counts when the LIVE script names the
 *   var anywhere: an entry that is not `skip: true`, a frame, or a fragment
 *   something live includes — the coverage module's reading
 *   (`collectScriptReferences`, whose `unincludedFragments` are left out:
 *   what one of those names plays nowhere).
 * - A scoped draw counts only when the live entry of one of its contracts
 *   names the var: in its own steps, in a fragment it includes (transitively,
 *   through fragments that include fragments), or in its frame's `open` /
 *   `close` — the entry's `frame`, else its contract's default, never
 *   `"none"`, and none at all around a body that can never play a clip
 *   (`canPlayClip`), since the engine expands no frame there — and the
 *   frame's `cut` only for a contract carrying `endsOn`, the only kind whose
 *   end plays it (the reference's own reading, `walkEntry` in
 *   `pack-reference.ts`). The spotter's call lines are scoped to
 *   `pit-crew.spotter-call` and its info lines to `pit-crew.spotter-info`,
 *   since the engine fires
 *   each set through its own contract only, so a pack that scripts only the
 *   call is not asked for "Clear.", and "Clear." shipped by such a pack is an
 *   orphan: nothing it scripts plays it.
 *
 * The per-entry reading is `collectScriptReferences` itself, run over a
 * script cut down to that one entry, the one frame it plays in and the
 * fragments it reaches, so it follows every step form, fragment include and
 * frame sequence the coverage module does.
 */
import { type CalloutScript, collectScriptReferences, NO_FRAME } from "@iracedeck/callout-script";

import type { ContractReport, VarDraw } from "../interpreter.js";
import { canPlayClip } from "./pack-reference.js";

/** A var as `vocabulary()` reports it — only the two fields this reading uses. */
export type DeclaringVar = { readonly name: string; readonly draws?: readonly VarDraw[] };

/**
 * A contract's id, default frame and ending event, as `contracts()` reports
 * them — what an entry without its own `frame` plays in, and whether its
 * frame's `cut` can ever play (`endsOnEvent` not `null`).
 */
export type ContractFrame = Pick<ContractReport, "id" | "frame" | "endsOnEvent">;

/**
 * The declared pools `script` reaches, as `group/base` → the names of the
 * vars that draw it there, sorted. A var that declared no `draws` is ignored
 * (its description is the linter's business), and so is every pool the
 * script does not reach by the rules in the header. Keys are in the order
 * the vars and their draws were declared.
 */
export function declaredDrawReferences(
  script: CalloutScript,
  vars: readonly DeclaringVar[],
  contracts: readonly ContractFrame[],
): Map<string, string[]> {
  const drawnBy = new Map<string, Set<string>>();
  const declaring = vars.filter((v) => v.draws !== undefined && v.draws.length > 0);

  if (declaring.length === 0) return new Map();

  const byId = new Map(contracts.map((c) => [c.id, c]));
  let wholeScript: ReadonlySet<string> | null = null;
  const byEntry = new Map<string, ReadonlySet<string>>();

  const namedAnywhere = (): ReadonlySet<string> => (wholeScript ??= liveVarNames(script));
  const namedByEntry = (contractId: string): ReadonlySet<string> => {
    let names = byEntry.get(contractId);

    if (names === undefined) {
      names = entryVarNames(script, contractId, byId.get(contractId));
      byEntry.set(contractId, names);
    }

    return names;
  };

  for (const { name, draws } of declaring) {
    for (const { group, base, contracts: scope } of draws ?? []) {
      const reached = scope === undefined ? namedAnywhere().has(name) : scope.some((id) => namedByEntry(id).has(name));

      if (!reached) continue;

      const key = `${group}/${base}`;
      const names = drawnBy.get(key) ?? new Set<string>();
      names.add(name);
      drawnBy.set(key, names);
    }
  }

  return new Map([...drawnBy].map(([key, names]) => [key, [...names].sort()]));
}

/**
 * The vars the live script names: every sequence `collectScriptReferences`
 * walks, less the fragments nothing live includes (`unincludedFragments`) —
 * the compiler converts a fragment only when something includes it.
 */
function liveVarNames(script: CalloutScript): ReadonlySet<string> {
  const { unincludedFragments } = collectScriptReferences(script);
  const fragments = Object.fromEntries(
    Object.entries(script.fragments ?? {}).filter(([name]) => !unincludedFragments.includes(name)),
  );

  return new Set(collectScriptReferences({ ...script, fragments }).vars);
}

/**
 * The vars one contract's entry names, when it is live: its own steps, the
 * fragments it reaches and its frame's sequences — {@link liveVarNames} over
 * the script with that entry as its only scenario and its frame as its only
 * frame, so every other entry's and frame's includes are out of the live set
 * too. An absent or `skip: true` entry names nothing. The frame's `cut` is
 * kept only for a contract carrying `endsOn`; a contract this reading does
 * not know has none.
 */
function entryVarNames(
  script: CalloutScript,
  contractId: string,
  contract: ContractFrame | undefined,
): ReadonlySet<string> {
  const entry = Object.hasOwn(script.scenarios, contractId) ? script.scenarios[contractId] : undefined;

  if (entry === undefined || entry.skip === true) return new Set();

  const frameName = entry.frame ?? contract?.frame;
  let frames: CalloutScript["frames"] = {};

  // No frame is expanded around a body that can never play a clip (the
  // engine's `canProducePlay`; the reference's `canPlayClip`).
  if (
    frameName !== undefined &&
    frameName !== NO_FRAME &&
    Object.hasOwn(script.frames, frameName) &&
    canPlayClip(script, entry.sequence ?? [])
  ) {
    const frame = { ...script.frames[frameName] };

    // A cut plays only when the line is ended early, which only an `endsOn` contract is.
    if (contract?.endsOnEvent == null) delete frame.cut;

    frames = { [frameName]: frame };
  }

  return liveVarNames({ ...script, scenarios: { [contractId]: entry }, frames });
}
