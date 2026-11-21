# A sim-neutral template engine, composed in deck-core

> **Issue:** [#1736](https://github.com/niklam/iracedeck/issues/1736) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Related: #1351 (the sim seam), #1339 (the lazy context), #1337 and #1345 (no template work per tick), #899 (live titles), #192 (expressions), #1730 (SimHub properties, blocked by this).

## The decision in one paragraph

The template engine moves out of `@iracedeck/iracing-sdk` into a new zero-dependency leaf, `@iracedeck/template-engine`: the expression evaluator, `resolveTemplate`, the `TemplateContext` lookup type, the empty context, the scalar leaf format, the object walk and two composition helpers. `iracing-sdk` keeps only what knows iRacing: the namespace builders, its per-tick cache and the press-time builders. `SimConnection` stops returning a finished title string (`resolveTitleTemplate` is removed) and hands deck-core the sim's lazy context and the namespace names it answers (`templateNamespaces`, `templateContext()`). deck-core composes that context with namespaces it owns (none in this issue; `simhub` is #1730's) and is the one place every display reader resolves through: key titles, Telemetry Display and Chat's key text. A new deck-core refresh signal drives those readers from sim ticks and from a deck-core namespace's own changes, so a value that belongs to no sim refreshes while the sim is closed. With no sim connected, the sim's namespaces render empty and deck-core's still resolve. Every template a user has written today renders exactly as before, which a golden test captured on the pre-move code proves.

## What this reverses

The #1351 spec settled that the pending sim connection returns title text "as typed (there is no template engine without a sim)", and made `resolveTitleTemplate(text): string` the seam's whole template surface. That was right while every namespace was a sim's. #1730 adds the first one that is not, and on that shape it would have to be registered into iRacing's context: SimHub values would show only while iRacing runs, and a second sim would wire the same namespace in again. This spec deliberately reverses both points: the engine is deck-core's to drive, a sim contributes namespaces to it, and the title path resolves with or without a sim. Nothing else of #1351 changes; `SimConnection` still carries no telemetry, session info or commands.

## Decisions

### 1. The package: `@iracedeck/template-engine`

`packages/template-engine`, ESM, built with `tsc`, no dependencies at all (not even `logger`). Its name says what it is; `templates` would collide with the icon Mustache templates (`icons`, `icon-composer`, the website's `resolveTemplateSample`), which are a different system and stay where they are.

| File | Contents | From |
| --- | --- | --- |
| `expression-evaluator.ts` | The tokenizer, parser, interpreter and AST cache, `MAX_EXPRESSION_LENGTH`, `ExpressionValue`, `VariableLookupResult`, `VariableLookup` | `iracing-sdk`, moved whole with its test |
| `template-resolver.ts` | `resolveTemplate(template, context)` | `iracing-sdk`, moved whole with its test |
| `template-context.ts` | `TemplateContext`, `TemplateLookup`, `TemplateValue`, `templateContextFromMaps`, `EMPTY_TEMPLATE_CONTEXT`, `namespacedContext`, `combineTemplateContexts` / `TemplateSource`, `isTemplateNamespaceName` | the sim-neutral part of `iracing-sdk`'s `template-context.ts`; `EMPTY_TEMPLATE_CONTEXT` from `deck-iracing` |
| `leaf.ts` | `LeafEntry`, `formatScalarLeaf`, `walkingNamespace` / `WalkOptions` | the scalar part of `formatLeaf`, and `leafAt` / `walkingNamespace` |
| `index.ts` | the barrel: every name above except the evaluator internals already marked `@internal`, which the package's own tests import by relative path | new |

The new and changed signatures:

```typescript
/** Answers one dot-notation path at a time (#1339). Unchanged. */
export interface TemplateContext {
  display(path: string): string | undefined;
  raw(path: string): TemplateLookup;
}

/** Frozen: every path absent. Moved from deck-iracing, which no longer exports it. */
export const EMPTY_TEMPLATE_CONTEXT: TemplateContext;

/** A name a namespace can have: reachable from both `{{a.b}}` and an expression segment. /^[A-Za-z_][A-Za-z0-9_]*$/ */
export function isTemplateNamespaceName(name: string): boolean;

/**
 * Routes a full path by its first segment to `namespaceOf(name)`, which answers the
 * rest of the path. A path with no dot, or whose namespace is undefined, is absent.
 * Memoising a namespace is the caller's choice (iRacing memoises per context, #1339).
 */
export function namespacedContext(namespaceOf: (name: string) => TemplateContext | undefined): TemplateContext;

export interface TemplateSource {
  /** The first path segments this source answers. */
  readonly namespaces: ReadonlySet<string>;
  /**
   * Called at most once per combined context, on the first lookup routed to this
   * source, never before. It receives full paths. Null answers every one absent.
   */
  readonly context: () => TemplateContext | null;
}

/**
 * One context over disjoint sources; throws when two sources name the same namespace.
 * Pure: it catches nothing, so a throw from a source's thunk or from one of its
 * lookups propagates to the caller of display/raw. Isolation is the caller's policy.
 */
export function combineTemplateContexts(sources: readonly TemplateSource[]): TemplateContext;

export interface LeafEntry {
  display: string;
  raw: TemplateLookup;
}

/** Yes/No for a boolean, an integer as is, any other number to two decimals, a string verbatim; undefined for null, undefined, objects and arrays. */
export function formatScalarLeaf(value: unknown): LeafEntry | undefined;

export interface WalkOptions {
  /** A key for which this returns true is absent, checked at every depth (iRacing skips `CarIdx*`). */
  skipKey?: (key: string) => boolean;
  /** The per-leaf rule, given the leaf's own key; defaults to formatScalarLeaf. */
  formatLeaf?: (key: string, value: unknown) => LeafEntry | undefined;
}

/** A namespace answered by walking `root` per lookup: own keys only, arrays and objects absent. */
export function walkingNamespace(root: object | null, options?: WalkOptions): TemplateContext;
```

`formatScalarLeaf` is today's `formatLeaf` without its one iRacing rule, `BOOLEAN_INT_FIELDS` (0/1 telemetry fields shown as Yes/No). The exotic-primitive branch (a bigint renders but is no expression value) moves with it.

### 2. What stays in `iracing-sdk`

`template-context.ts` keeps everything that knows iRacing: `DriverEntry`, the driver field builders, `BOOLEAN_INT_FIELDS` and the iRacing `formatLeaf(key, value)` (that set first, then `formatScalarLeaf`), the session-info memo, the driver finders, `namespaceBuilders`, `buildTemplateContextFromData` and `buildTemplateContext`. The builder is rewritten on the engine's helpers and nothing else changes: its memo of built namespaces feeds `namespacedContext`, and `telemetry` and `sessionInfo` are `walkingNamespace` with `{ skipKey: (key) => key.startsWith("CarIdx"), formatLeaf }` and `{ formatLeaf }`. Today's `excludePrefix` is checked against every segment, not only the first, and `skipKey` keeps that: it is asked at every depth. It answers full paths, as today, so its 2,000-line suite, the #1339 reference oracle (`template-context-reference.test-helper.ts`) and Chat's and Race Admin's press-time builds are untouched.

One export is new: `IRACING_TEMPLATE_NAMESPACES`, `Object.freeze(Object.keys(namespaceBuilders))`, derived so it cannot drift from the builders. `SDKController.getCurrentTemplateContext()` stays as it is, the per-tick cache #1337 introduced and #700's `CamCarIdx` rebuild included; after this issue its only reader is `SimIRacingConnection`.

`index.ts` drops `resolveTemplate`, `templateContextFromMaps`, `TemplateContext`, `TemplateLookup` and `TemplateValue`. They are not re-exported: every name has one import path, as in deck-core since #1364, so a consumer imports them from `@iracedeck/template-engine`.

### 3. The `SimConnection` change

```typescript
import type { TemplateContext } from "@iracedeck/template-engine";

export interface SimConnection {
  isConnected(): boolean;
  subscribe(id: string, onTick: (isConnected: boolean) => void): void;
  unsubscribe(id: string): void;
  activeFlags(): readonly OverlayFlag[];
  /**
   * The first path segments this sim's template context answers (iRacing: `self`,
   * `track_ahead`, … `sessionInfo`). Fixed for the connection's life: deck-core
   * reads it once, in initializeSimConnection. Each name passes isTemplateNamespaceName.
   */
  readonly templateNamespaces: readonly string[];
  /**
   * The sim's template context as of its latest tick, or null when it has nothing to
   * answer (disconnected, no telemetry yet). It answers full paths. It must be lazy,
   * building nothing until a path is read (#1339), and cheap to call several times a
   * tick (iRacing returns its per-tick cache). deck-core reads a throw as null.
   */
  templateContext(): TemplateContext | null;
}
```

`resolveTitleTemplate(text): string` is removed rather than kept beside the new members. Kept, it would be a second resolution path that a sim could implement without deck-core's namespaces, so a title and a Telemetry Display value could disagree; and it has no caller outside deck-core's own `title-template.ts` and test fakes. Its one implementation, `SimIRacingConnection`, becomes:

```typescript
readonly templateNamespaces = IRACING_TEMPLATE_NAMESPACES;

templateContext(): TemplateContext | null {
  return this.controller.getCurrentTemplateContext();
}
```

Its try/catch fallbacks move up into deck-core (section 5), so the connection no longer needs `EMPTY_TEMPLATE_CONTEXT` and `deck-iracing` stops exporting it.

**The pending connection** (before `initializeSimConnection`) answers `templateNamespaces` through a getter, `current?.templateNamespaces ?? []`, and `templateContext()` as `current ? current.templateContext() : null`, so a reference kept from before initialisation still delegates, as every other member does. deck-core itself routes by the names it claimed at initialisation (below), never by re-reading the getter. A title resolved before initialisation therefore renders its sim variables empty instead of returning the text as typed. No plugin can observe the difference, since `initCore` installs the connection before `registerActions` registers any action, and a test pins the new behaviour.

### 4. Namespaces deck-core owns: registration and collisions

```typescript
export interface DeckTemplateNamespace {
  /** Answers the path after `<name>.`; live, so each lookup reads the current value. Built once, never per tick. */
  readonly context: TemplateContext;
  /** Calls `listener` when a value it answers may have changed; returns the remover. Optional. */
  readonly onChange?: (listener: () => void) => () => void;
}

/** @throws Error on an invalid name, a name already registered, or a name the installed sim answers. */
export function registerTemplateNamespace(name: string, namespace: DeckTemplateNamespace): () => void;
```

The returned function unregisters it. No production code registers one in this issue; `registerTemplateNamespace` is the seam #1730 needs, and its tests drive it with a test namespace. A deck-core namespace answers the remainder of the path, as iRacing's own per-namespace builders do, while the sim's context answers full paths, so iRacing's builder stays as it is.

**Collision rules.** Every top-level name has exactly one owner, so there is no precedence to decide and no shadowing to explain to a user.

- A name must pass `isTemplateNamespaceName`. A dotted name, `simhub.x`, would be unreachable as one segment.
- `registerTemplateNamespace` throws for a name already registered, or one in the installed sim's claimed set.
- `initializeSimConnection` reads `connection.templateNamespaces` once and throws, before installing anything (like its `absentDelayMs` check), for an invalid name, a name listed twice, or a name deck-core has registered. Either order of registration and initialisation is therefore checked, and #1730 may register `simhub` in whichever phase suits it.
- `_resetSimConnection()` forgets the claimed set; `_resetTemplateNamespaces()` forgets the registry.

The registry and the claimed set live in their own deck-core module, `template-namespace-registry.ts`. It imports nothing else from deck-core, and both `sim-connection.ts` and the new `template-context.ts` import it, so no two of the three import each other. The plugin builds fail on a cycle among our own sources (`plugin-structure.md`). The registry never calls the modules above it. Whoever needs to know about a registration subscribes to it: `onTemplateNamespacesChange(listener) → remove` calls `listener(name, namespace | undefined)` on every registration and unregistration. The refresh signal (section 6) is that subscriber, so it can attach a namespace's `onChange` the moment the namespace is registered.

### 5. How deck-core composes and resolves

deck-core's `template-context.ts` exports the resolving half of the readers' surface. The refresh half lives in `sim-connection.ts` (section 6). deck-core re-exports nothing from the engine.

```typescript
// template-context.ts
/** The combined context for one resolution. Never null, never throws. Hold none across ticks. */
export function getTemplateContext(): TemplateContext;

/** Telemetry Display's rule: `hasSource` is true when the sim has a context, or a lookup reached a deck-core namespace. */
export function resolveDisplayTemplate(text: string): { text: string; hasSource: boolean };

// sim-connection.ts
/** Called on every sim tick and every deck-core namespace change; never at registration. */
export function subscribeTemplateRefresh(id: string, onRefresh: () => void): void;
export function unsubscribeTemplateRefresh(id: string): void;
```

`title-template.ts` keeps `titleHasTemplate` and `resolveTitleTemplate(text)` with their signatures. The latter now returns `resolveTemplate(text, getTemplateContext())` for text containing `{{`, and the text as typed only if that throws.

**`getTemplateContext()`** returns `combineTemplateContexts` over two sources: the sim (its claimed names, its `templateContext` as the thunk) and deck-core (the registry's names, `namespacedContext` over the registry). A new combined object costs two closures and is built per call. The readers call it inside their throttle flush, at most ten times a second per key.

- **Lazy.** The sim's `templateContext()` is called at most once per combined object, and only when a path in a sim namespace is read, so a template that reads only deck-core namespaces costs the sim nothing. Within the sim's context, #1339's laziness is unchanged: only the namespaces read are built.
- **Isolated.** The engine's combiner is pure and lets a throw through, so deck-core wraps each source before handing it over. Each sim namespace is wrapped, and so is each registered deck-core namespace.
  - A throw from `templateContext()` reads as null, so the sim's namespaces render empty. That is what `SimIRacingConnection` does today.
  - A throw from one lookup, sim or deck-core, reads as that path absent, and the rest of the template resolves.
  - Every throw is reported through a deck-core boundary from `@iracedeck/logger`'s `createErrorBoundary`, keyed `templateNamespace:<name>`. Its bounded reporter writes the first throw with its stack, then a count at most once a minute, so a namespace failing every frame is reported once, not per lookup or per key.
  - The boundary logs through the logger `initializeSimConnection` was given, the one the presence signal uses, and is silent before that.
  - Today a lookup that throws mid-resolve makes `SimIRacingConnection` re-render the whole template against the empty context. This is the one deliberate output difference, and only on a failure path no user template produces. It is what keeps a failing SimHub reader from blanking iRacing values on the same key.
- **Empty without a sim.** No connection, a disconnected one and a null context all answer every sim path absent: `{{self.name}}` renders empty, `{{= self.position + 1 }}` is an unknown variable and renders empty, and a parse error stays verbatim. Those are today's `EMPTY_TEMPLATE_CONTEXT` rules, now reached by routing.

**`resolveDisplayTemplate`** exists because Telemetry Display does not render the empty result while the sim is gone. Today it shows `---` whenever the controller has no context, even for `Speed: {{telemetry.Speed}}`, whose literal text would otherwise remain. Its rule becomes `hasSource ? text || "---" : "---"`. With no deck-core namespace registered, `hasSource` is exactly "the sim has a context", so every existing template keeps today's output. A template that reads a deck-core namespace (#1730) renders while iRacing is closed. `hasSource` is set by a wrapper on the deck-core source of that one combined context, and by calling the sim thunk once, which builds no namespace.

### 6. Readers, refresh and the per-tick costs

| Reader | Today | After |
| --- | --- | --- |
| Key titles (`BaseAction`'s #899 watcher, `resolveTitleSettings`) | subscribes to `getSimConnection()`, resolves through `SimConnection.resolveTitleTemplate` | subscribes with `subscribeTemplateRefresh`, resolves through deck-core's `resolveTitleTemplate` |
| Telemetry Display value and title | `this.sdkController.subscribe` per context, `getCurrentTemplateContext()` | `subscribeTemplateRefresh` per context, `resolveDisplayTemplate` and `resolveTitleTemplate`; it reads nothing else from the controller, so it extends `ConnectionStateAwareAction` instead of `SimIRacingAction` |
| Chat key text and message preview | `this.sdkController.subscribe` per context, `getCurrentTemplateContext() ?? EMPTY_TEMPLATE_CONTEXT` | `subscribeTemplateRefresh` per context, `resolveTemplate(…, getTemplateContext())`; it stays a `SimIRacingAction` for its send path |
| Chat's send, Race Admin's send | `buildTemplateContext(sdkController)` at the press | unchanged, with `resolveTemplate` imported from the engine |

**The refresh signal.** It lives in `sim-connection.ts`, beside the presence signal it resembles, so `_resetSimConnection()` resets it with everything else: its subscribed flag, its listeners, its boundary and its `onChange` removers, as the presence signal's timer, listeners and subscription are reset today. `subscribeTemplateRefresh` holds one subscription on the sim connection (`__template_refresh__`), made on the first listener and dropped with the last, and queued like any subscription before the connection exists. It also holds one `onChange` per registered deck-core namespace while listeners exist. It finds them through the registry's `onTemplateNamespacesChange`, so a namespace registered meanwhile is attached at once, and one unregistered is released. It never calls a listener at registration; each reader renders on appear itself, as today. Every listener runs through `@iracedeck/logger`'s `createErrorBoundary` under its id. This matters because the controller's boundary now isolates deck-core's single subscription as a whole: before, each Telemetry Display and Chat context was a controller subscriber of its own and isolated there. The `SimConnection.subscribe` contract (#1558) is thereby kept one level down.

**The throttle path is unchanged.** A refresh only schedules the reader's 10 Hz `IconUpdateThrottle`, and the flush resolves (#1339 §5, #1345), so a tick still asks for no context and resolves nothing. With no deck-core namespace registered, the refresh fires exactly on the sim's ticks and connection changes, the timing every reader has today. A deck-core namespace's `onChange` adds a second trigger; the throttle coalesces the two.

**What this does to per-tick cost.**

- The iRacing context is still built once per tick and shared by every key that renders on that frame, as #1337 made it, and only the namespaces read are built (#1339). Nothing in deck-core builds or caches per tick.
- The SDK controller sees one template subscriber instead of one per templated Telemetry Display and Chat key, so a tick runs fewer controller callbacks. The fan-out to readers costs what the per-context callbacks cost before.
- A deck-core namespace is a live lookup, so composing it costs a map lookup per path.

### 7. The dependency graph after the move

```text
template-engine   (no internal or third-party dependencies; sim-neutral)
iracing-sdk      -> template-engine                      new
deck-core        -> template-engine                      new; still no iracing-sdk
deck-iracing     -> template-engine                      new (SimIRacingConnection's types, the golden test)
iracing-actions  -> template-engine                      new (Chat, Race Admin)
```

No edge is removed: `iracing-actions` still needs `iracing-sdk` for `buildTemplateContext`, and `deck-iracing` for `SimIRacingAction`. `template-engine` is bundled into the plugins through those packages like any workspace package. It is no Rollup external, adds nothing to `bin/package.json` and no third-party licence, and no plugin shell imports it. It joins `SIM_NEUTRAL_PACKAGES` in `eslint.config.js`, so it can never import a sim package.

### 8. The guards a new package must satisfy

Each is a root test that discovers packages, so the package is red until it complies:

- `scripts/sim-boundary-coverage.test.mjs`: the package is decided. It is added to `SIM_NEUTRAL_PACKAGES` in `eslint.config.js`, with its reason as a comment there, as the list's other groups have: "the template engine, which every sim's context and deck-core's namespaces are built on". The guard itself keeps reasons only for its `SIM_SIDE` packages.
- `scripts/typecheck-script-coverage.test.mjs`: a `typecheck` script whose program includes the test files, with neither allow-list entry.
- `scripts/package-test-scripts.test.mjs`: the two byte-identical `test` / `test:watch` scripts over `scripts/test-package.mjs`.
- `scripts/vitest-alias-coverage.test.mjs`: an alias `@iracedeck/template-engine` → `packages/template-engine/src/index.ts` in the root `vitest.config.ts`, for its one `exports` entry.
- `scripts/tsconfig-base-inheritance.test.mjs`: `tsconfig.json` extends `tsconfig.base.json` and repeats no base value (`fetch-utils`' config is the shape).
- `scripts/turbo-inputs.test.mjs`: its build reads only its own package, so nothing is declared. A change that reads anything else must declare it.
- `scripts/cross-package-reach.test.mjs`: no test reaches a sibling's files by path. That is why the golden test's fixture inputs are serialised into `deck-iracing` rather than imported from `iracing-sdk`'s test helper.
- `scripts/testing-entries-test-only.test.mjs`: deck-core's existing `./testing` entry gains the fake connection (commit 4), and is still imported only from tests.
- `scripts/lint-format-coverage.test.mjs` and `scripts/lint-format-ignores.test.mjs`: covered by their globs, and the package has no `build/` directory.
- `scripts/claude-rules-frontmatter.test.mjs`: the new line in `.claude/CLAUDE.md`'s package list must fit the always-loaded budget.

The new package has no `./testing` entry of its own. Its version is the workspace's current one. `pnpm-lock.yaml` is committed with the manifests.

### 9. Migration order

Each commit builds, typechecks and passes the suite on its own:

1. **`test(deck-iracing): pin every template's rendered output before the engine moves (#1736)`.** This adds the serialised fixtures, the corpus and the golden outputs under `deck-iracing`'s `src/__fixtures__/template-golden/`, with `template-golden.test.ts` (Testing). Nothing in `iracing-sdk` changes. This commit is green on the old code, which is what makes the golden file "before".
2. **`refactor(template-engine): move the template engine out of iracing-sdk (#1736)`.** The package is created by `git mv` of the evaluator and resolver and their tests; the sim-neutral part of `template-context.ts` is moved, and `EMPTY_TEMPLATE_CONTEXT` comes over from `deck-iracing`. The engine's dependents and every import switch in the same commit: `iracing-sdk`'s barrel drops the moved names, and `deck-iracing`, `iracing-actions` and the tests import from the engine. Also in this commit: the alias, the `SIM_NEUTRAL_PACKAGES` entry and the lockfile. The golden and #1339 suites stay green, with only their imports changed.
3. **`refactor(iracing-sdk): build the iRacing context on the engine's namespace helpers (#1736)`.** `namespacedContext`, `walkingNamespace`, `formatScalarLeaf` behind the iRacing `formatLeaf`, and `IRACING_TEMPLATE_NAMESPACES`. The golden and #1339 suites stay green.
4. **`refactor(deck-core): the sim connection hands deck-core its template context (#1736)`.** This is the `SimConnection` change, the registry, `getTemplateContext` / `resolveDisplayTemplate` / `subscribeTemplateRefresh`, the title watcher's move and `resolveTitleTemplate` over the combined context. `SimIRacingConnection` and the canonical deck-core mock factory (`action-tests.md`) are updated with it. The commit also covers the test doubles. Six tests hand-write a `SimConnection` literal that sets `resolveTitleTemplate` and lacks the new members, so they would fail typecheck:
   - the four `*-disconnected.test.ts` in `audio-controls`, `pit-crew`, `switch-profile` and `telemetry-control`;
   - `telemetry-display.test.ts`;
   - `deck-iracing`'s `sdk-singleton.test.ts`.

   Instead of each being patched, deck-core's existing `fake-sim-connection.test-support.ts` is updated, exported from `@iracedeck/deck-core/testing`, and replaces all six copies. Its next change is then one edit. It is one commit because the interface, its implementer and its fakes cannot build apart.
5. **`refactor(iracing-actions): Telemetry Display and Chat read templates through deck-core (#1736)`.** This includes Telemetry Display's move to `ConnectionStateAwareAction`.
6. **`docs: the template engine is its own package, composed in deck-core (#1736)`.** This commit updates:
   - the Architecture page:
     - the `template-engine` foundation node and its four edges;
     - SEAM 3's prose and its diagram label (`connected · flags · template context`);
     - the hourglass opening sentence;
     - the "Three things to notice" paragraph after the first diagram (about line 65) and the "Inbound is abstracted" leak bullet (about line 539), which both say title templates come through the sim connection;
     - the `SimIRacingAction` count, 26 → 25;
   - `README.md`'s package table and its `deck-iracing` line;
   - `.claude/CLAUDE.md`'s package list;
   - a `CLAUDE.md` for the new package;
   - `iracing-sdk`'s, `deck-core`'s and `deck-iracing`'s `CLAUDE.md`;
   - `stream-deck-actions.md` (*Title template variables*, and the `SimIRacingAction` requirement, which names "the template context").

   No changelog fragment: nothing a user sees changes.

The #1730 spec is rewritten on top of this before it is committed. Its `SDKController.setTemplateNamespace` hook, its "the poll stops by itself when iRacing closes" and its "no new seam" are all superseded.

## Out of scope

- **Any namespace of deck-core's own.** `simhub` and its reader are #1730. So is whether a Telemetry Display key that reads only SimHub should still get the disconnected look (`needsSim`) while iRacing is closed.
- **Chat's and Race Admin's send-time templates.** They stay on `buildTemplateContext`, a fresh iRacing build at the press. Whether a send reads deck-core namespaces is #1730's question.
- **Template syntax, grammar, functions or formatting.** Both placeholder grammars and the evaluator move byte for byte.
- **Moving the per-tick context cache out of `SDKController`,** or making it sim-neutral.
- **A sim-neutral read model** for the telemetry and session info actions read directly (#714), and porting the other `SimIRacingAction` readers.
- **The icon Mustache templates** (`icons`, `icon-composer`, the website gallery's `resolveTemplateSample`), a separate system that shares only the brace syntax.
- **Several sims at once.** One sim connection claims its names. Two connected sims would need a namespace prefix rule, decided when a second sim is real.

## Testing

**The golden test (`deck-iracing`, commit 1).** It proves that no existing template changes what it shows, measured on the path a user's title takes. It goes through deck-core's `resolveTitleTemplate(text)`, whose signature is the same before and after the move. That resolves through a real `SimIRacingConnection`, installed with `initializeSimConnection` (`_resetSimConnection` between tests), over a fake controller. So the same test exercises `SimConnection.resolveTitleTemplate` at commit 1 and deck-core's composition from commit 4 on. It lives in `deck-iracing`, the one package that depends on deck-core, the connection and `iracing-sdk`, under `src/__fixtures__/template-golden/` and `template-golden.test.ts`. No separate differential test is needed beside it.

- **The fixture inputs** (`fixtures.json`): the #1339 equivalence fixtures, serialised as data: telemetry, session info and the live order per fixture. `scripts/cross-package-reach.test.mjs` forbids importing `iracing-sdk`'s test helper by path, so they are written once from `equivalenceFixtures()` by the same throwaway script as the outputs below. A fixture without an order carries `livePositions: null`.
- **The fake controller:** its `getCurrentTemplateContext()` returns `buildTemplateContextFromData(telemetry, sessionInfo, () => livePositions)`. The live order is passed as a provider, the shape `SDKController` passes, so the lazy order read (#1339) is what the test exercises. A disconnected controller returns `null`.
- **The corpus** (`corpus.json`):
  - every variable on the website's *Template variables* page: the six driver prefixes × every field, `session.*`, `track.*`, and every telemetry name the page lists, each as `{{…}}` and inside `{{= … }}`;
  - every example in the page's *Examples* section;
  - the expression edge cases: each function, `empty()`, a ternary, a string comparison, `round` with fixed decimals, literal text around variables, an unknown variable, an unknown namespace, a bare `{{nodot}}`, `{{constructor.name}}`, `{{telemetry.CarIdxPosition}}`, a parse error, an unclosed `{{=`, an expression over `MAX_EXPRESSION_LENGTH`, and a `}}` inside a string literal;
  - one entry with no `{{`, which pins the title path's shortcut.
- **The expected outputs** (`expected.json`) are written once on the pre-move tree by a throwaway script that is not committed. Each corpus entry has three columns:
  - *title*: deck-core's `resolveTitleTemplate` per fixture, connected;
  - *disconnected*: the same with the controller returning `null`;
  - *raw*: `resolveTemplate(t, buildTemplateContextFromData(telemetry, sessionInfo, () => livePositions))` per fixture, the iRacing context on its own.

  The raw column fails on its own when the engine move or commit 3's rewrite changes output. The title columns fail when the composition does.
- **The test** recomputes all three and compares them with `expected.json` string for string.
- **Never regenerated.** The test has no update mode, and a diff to `expected.json` after commit 1 is a review finding.
- **Guards against passing vacuously.** The entry count equals corpus × columns; every fixture column has non-empty outputs; at least one entry keeps a parse error verbatim; at least one is empty for an unknown variable. Before commit 1 lands, one expected entry is flipped by hand and the test must fail; the PR body records that.

**Suites that move or stay.** These pass with only their imports changed, which `git diff -M` shows:

- `expression-evaluator.test.ts` and `template-resolver.test.ts`, now in the engine;
- `iracing-sdk`'s `template-context.test.ts`: the #1339 equivalence with the eager reference, the laziness spies on `namespaceBuilders`, and the session-info memo.

**Engine unit tests:**

- `namespacedContext`: no dot is absent; prototype names (`constructor`, `__proto__`) are absent; the remainder is passed on.
- `combineTemplateContexts`: full paths route to the owning source; an unknown first segment is absent; a thunk is called at most once and only on a lookup routed to it; a null context is absent; overlapping sources throw; a throw from a thunk or a lookup propagates uncaught.
- `walkingNamespace` with and without `formatLeaf`, and with a `skipKey` that skips a key at the first segment and at a deeper one.
- `formatScalarLeaf`: booleans, integers, two decimals, strings, null, objects, arrays and a bigint.
- `isTemplateNamespaceName`, accepted and refused.
- `EMPTY_TEMPLATE_CONTEXT` is frozen and absent for prototype names.

**deck-core**, over the fake connection extended with `templateNamespaces` and `templateContext`:

- **Before initialisation:** sim paths render empty and a registered namespace resolves. This pins the reversal of "as typed".
- **Collisions:** throws in both orders, for an invalid or dotted name and for a name the sim lists twice. Nothing is installed when `initializeSimConnection` throws. `onTemplateNamespacesChange` hears a registration and an unregistration. `_resetSimConnection()` leaves the refresh signal with no listeners, no sim subscription and no `onChange` attached, and `_resetTemplateNamespaces()` leaves an empty registry.
- **The sim context:**
  - a throwing `templateContext()` renders sim paths empty;
  - a throwing lookup, in a sim namespace or a registered one, leaves the template's other variables resolved;
  - a namespace that throws on every lookup for many resolutions is reported through the boundary once under `templateNamespace:<name>`, not per lookup;
  - `templateContext()` is not called for a template that reads no sim namespace.
- **`resolveDisplayTemplate`'s `hasSource`:** true with the sim context present; true with the sim context absent when a lookup reached a deck-core namespace; false with the sim context absent and no deck-core lookup.
- **`subscribeTemplateRefresh`:**
  - one sim subscription for any number of listeners, dropped with the last;
  - queued before initialisation;
  - fires on a sim tick and on a namespace's `onChange`, never at registration;
  - a namespace registered while listeners exist is subscribed;
  - a throwing listener neither stops the others nor reaches the caller, and is reported once.
- **`BaseAction`:** a templated title over a registered test namespace refreshes on that namespace's `onChange` while the sim connection is disconnected and ticks nothing. This is the path #1730 depends on, proven here with no SimHub code.

**`deck-iracing`:**

- `SimIRacingConnection.templateNamespaces` equals `IRACING_TEMPLATE_NAMESPACES`, which equals the keys of `namespaceBuilders`.
- `templateContext()` returns the controller's per-tick context, and null with no telemetry.
- The golden test above, which runs the user's title path through this connection.

**`iracing-actions`:**

- **Telemetry Display:** `---` with no sim context, for a template with literal text as well (today's rule, pinned); `---` for a connected empty value; the value when connected.
- **Telemetry Display throttle:** the #1339 test, moved onto `subscribeTemplateRefresh`. A burst of refreshes inside one window resolves at most twice, a disappearing key drops its pending flush, and no tick calls `templateContext()`.
- **Chat:** the key text resolves empty variables with no sim and renders them when connected; a key without templates never schedules.
- **The disconnected look:** the four `*-disconnected` tests and `telemetry-display.test.ts` use the shared fake connection from `@iracedeck/deck-core/testing` instead of their own `SimConnection` literals (commit 4).

**The whole gate.** `pnpm install`, `build`, `typecheck`, `format`, `lint` and `test`, with the build output read for `TS[0-9]+:` and any `(!)`, and every root guard in section 8 green. The architect reviews the spec before implementation, since it changes `SimConnection`. The `/code-review` runs at `xhigh`, since `SimConnection` is a published contract, and the second read applies (a gate: the namespace collision checks).

**Manual test by Niklas,** on the Stream Deck and on the Mirabox hardware, in an iRacing session:

- a Title Text with `{{self.position}}` and an expression updates live;
- a Telemetry Display key with `Speed: {{telemetry.Speed}}` shows the value, and `---` once iRacing is closed;
- a Chat key whose key text holds a template renders it, and its send still resolves at the press;
- on a paused replay, moving the camera to another car updates a `{{focused.name}}` title (#700's rebuild on `CamCarIdx`);
- every templated key he already has on his profiles shows what it showed before the change.
