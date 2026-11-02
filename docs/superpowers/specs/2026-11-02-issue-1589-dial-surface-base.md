# A shared base for the dial surfaces

> **Issue:** [#1589](https://github.com/niklam/iracedeck/issues/1589) · **Related:** [#1329](https://github.com/niklam/iracedeck/issues/1329), [#269](https://github.com/niklam/iracedeck/issues/269), [#1597](https://github.com/niklam/iracedeck/issues/1597), [#1072](https://github.com/niklam/iracedeck/issues/1072), [#1243](https://github.com/niklam/iracedeck/issues/1243) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The 18 dial surfaces in `packages/iracing-actions/src/actions/*/*-dial-surface.ts` are 18 unrelated classes. There is one per `Encoder` action in the Elgato manifest (18 of them; the Camera Focus UUID is owned by `camera-controls/`). Two cross-cutting features have each been pasted into every class. #1329 added the late-input gate, and #269 added the press shapes. The 2026-10-20 review recorded the missing base (`docs/architecture/reviews/2026-10-20-architecture-review.md:309-317`), and the 2026-11-01 review measured its cost on the second feature (`2026-11-01-architecture-review.md:250-254`, follow-up 5 at `:343`).

### What is duplicated, measured

Members were grouped by body after normalising comments, whitespace, the context type name and the settings parameter name. Spans count each member with its JSDoc, on `master` at `c62f1eaae`.

| Member | Surfaces | Variants | Lines | How they differ |
| --- | --- | --- | --- | --- |
| `inputContext` | 18 | 2 | 288 | Identical except the map's name: `contextsState` in 16 surfaces, `contexts` in Replay Control (`replay-control-dial-surface.ts:569`) and Replay Markers (`replay-markers-dial-surface.ts:207`). Every copy is `hasDialInputContext(map, action.id, event, this.host.logger) ? this.ensureContext(action, settings) : undefined` (e.g. `setup-aero-dial-surface.ts:322-330`). |
| `ensureContext` | 18 | 10 | 538 | The scaffold is shared: get, create and `set` when absent, refresh when present, return. Two things vary. The creation literal varies: per-surface fields, the hold preview (`camera-dial-surface.ts:1231-1262`) and Replay Control's lazy search subscription (`replay-control-dial-surface.ts:1393`). The refresh varies too: action and settings in 15 surfaces, action only in the three that keep stored settings authoritative. Those are Fuel Service (`fuel-dial-surface.ts:1790-1792`), Setup Chassis (`setup-chassis-dial-surface.ts:584-586`), and Audio Controls, which assigns `ctx.settings` at each call site instead (`audio-dial-surface.ts:300, 321, 331, 374`; `ensureContext` at `:554-565`). |
| `pressShape` | 17 (not Audio) | 6 | 242 | 12 are identical: a `this.contextsState.has` guard, then `dialGestureShape` over the event's `pressAction` / `longPressAction` (e.g. `setup-aero-dial-surface.ts:220-228`). Setup Brakes reads `settings.dial.*` (`setup-brakes-dial-surface.ts:308`). Fuel Service and Setup Chassis read the context's stored settings (`fuel-dial-surface.ts:1192-1202`, `setup-chassis-dial-surface.ts:426-436`). Replay Control resolves its slots through `resolveDialGesture` (`replay-control-dial-surface.ts:982-990`). Replay Markers differs only in the map name. |
| `touchShape` | 17 | 6 | 118 | Mirrors `pressShape`, over `touchGestureShape`. |
| `willDisappear` | 18 | 6 | 110 | 10 are a bare `this.contextsState.delete(actionId)`. The other 8 tear down first, and their order matters. Hold-preview `dispose` comes first in four. Audio Controls awaits the PTT release before the delete (`audio-dial-surface.ts:306-317`). Replay Control unsubscribes the search once the map is empty, after the delete (`replay-control-dial-surface.ts:748-769`). |

So the 13 `contextsState.has` guards the review counted are the 12 identical copies plus Setup Brakes. Every surface writes its map in exactly two places: one `set` in `ensureContext` and one `delete` in `willDisappear`.

The issue says 21 action files gained delegating members for #269. Of those, 19 declare `dialPressShape` / `touchPressShape`, and AI Spotter Controls and Pit Crew declare only `keyPressShape`. Of the 19, 17 delegate to their surface in two or three lines (e.g. `setup-aero.ts:392-403`). Audio Controls computes its own dial shape, because its presses fire at `dialDown` (`audio-controls.ts:249-261`, `:340-342`). Car Control has a `dialPressShape` but no surface and no `Encoder` declaration.

Other members also repeat but are not this issue's (see *Out of scope*). `refreshAll` is identical in 12 surfaces and `onTelemetry` in 12. `down` has 2 variants across 17 surfaces, and the preamble of `up` (consume `pressStart`, then classify) is shared by 17.

The review's "verbatim lines shared by nine or more surfaces" figure (1,807 → 1,930) comes from a `dup.mjs` that is not committed, so this spec cannot reproduce it. It measures member spans instead, and the PR reports those before and after.

### What the current state costs

- **A new cross-cutting member costs 18 copies.** #269 shows it: the logic sits in shared functions (`shared/dial-release.ts:56-88`), and the wrappers around it are copied.
- **The late-input rule is proven per surface, and only in 6.** Explicit late-input suites exist for Audio Controls, Camera Controls, Fuel Service, Replay Control, Replay Markers and Setup Chassis (e.g. `fuel-dial-surface.test.ts:2732`). The other 12 surfaces follow the rule today, since every `rotate` / `down` / `touchTap` reaches its context only through `this.inputContext(` (measured). But nothing checks that, and nothing would notice a 19th surface that does not.

## What the code constrains

1. **Every surface test mocks `@iracedeck/deck-core` with a hand-written factory.** All 18 surface tests do, and 15 of them do it without `importOriginal` (e.g. `setup-aero-dial-surface.test.ts:16`). A runtime class exported from deck-core would therefore be `undefined` under those mocks, and `class X extends undefined` would throw at import. Relative imports of `src/shared/` are not mocked by any surface test, except `replay-busy-indicator` and `mouse-to-sim`.
2. **The press-shape helpers read `__FEATURE_DIAL_EXTENDED_GESTURES__`** (`dial-release.ts:27, 63, 83`). The rule keeps that gating in the action package, never in deck-core (`encoders-and-touchscreen.md:60`, *Where dial gating lives*).
3. **Some surfaces keep their stored settings authoritative.** Rule 10 (`encoders-and-touchscreen.md:84`) forbids refreshing stored settings from an input payload in a surface that persists settings plugin-side. Their press shapes read the context's settings (`fuel-dial-surface.ts:1195-1201`). The shared press-shape suite pins that difference as `readsStoredSettings` (`shared/press-shape.test-support.ts:53, 172-176`).
4. **Teardown order is behaviour.** Audio Controls' PTT release must complete before its context is deleted, and Replay Control's search unsubscribe must follow its delete (table above).
5. **Tests reach the map by its field name.** 23 reads in six test files do this: `surface["contextsState"]` in the Audio, Camera, Fuel and Chassis tests, and `surface["contexts"]` in 11 lines of the two replay tests (`replay-control-dial-surface.test.ts:2174-2543`, `replay-markers-dial-surface.test.ts:1193-1231`). No test reaches `ensureContext` or `inputContext`, and no test spies on a surface member. `replay-control.test.ts:171-199` replaces the whole surface module with a recorder of its public members.
6. **The public surface API is what the actions call.** That is `willAppear`, `willDisappear`, `didReceiveSettings`, `rotate`, `down`, `up`, `touchTap`, `pressShape(action, settings)` and `touchShape(action, settings, hold)`. Each surface's `settings` parameter has the same type in its lifecycle members and its shape members.
7. **The `shared/dial-*` modules must stay liftable** to a sim-neutral package (#1013, #1437). They import only deck-core, zod and each other, and `shared/dial-sim-agnostic.test.ts:16-50` checks this for every `dial-` prefixed module.
8. **`noImplicitOverride` is on** (`tsconfig.base.json`), so every implementation of a base member carries `override`.

## Decisions

### 1. Two abstract base classes in `shared/dial-surface-base.ts`

The shape is an abstract base class that every surface extends. A second, narrower class adds the press shapes.

```typescript
/** What the base reads from a surface's host: the logger the gate's one drop line goes to. */
export interface DialSurfaceHost {
  readonly logger: { debug(message: string): void };
}

/** The four gesture slots a surface fires, resolved for one context (`none` or `null` fires nothing). */
export interface DialGestures {
  press: ResolvedDialGesture;
  longPress: ResolvedDialGesture;
  tap: ResolvedDialGesture;
  longTouch: ResolvedDialGesture;
}

/** The common case: the four `*Action` slots of a dial settings object, unresolved. */
export function gestureSlots(dial: {
  pressAction: string;
  longPressAction: string;
  tapAction: string;
  longTouchAction: string;
}): DialGestures;

export abstract class DialSurfaceBase<Ctx extends { action: IDeckActionContext }, S> {
  /** Per-context state. Private: only ensureContext and forgetContext write it. */
  private readonly contextMap = new Map<string, Ctx>();
  /** The read-only view every surface reads (get, has, values, size). A write through it is a type error. */
  protected get contextsState(): ReadonlyMap<string, Ctx>;
  protected abstract readonly host: DialSurfaceHost;

  /** A new context for a lifecycle event. Builds it without storing it; the base stores it. */
  protected abstract createContext(action: IDeckActionContext, settings: S): Ctx;
  /** What a lifecycle or input event refreshes on an EXISTING context (rule 10 decides whether settings are refreshed). */
  protected abstract refreshContext(ctx: Ctx, action: IDeckActionContext, settings: S): void;

  /** Lifecycle events only (willAppear, didReceiveSettings): get or create, then refresh. */
  protected ensureContext(action: IDeckActionContext, settings: S): Ctx;
  /** Input events only (rotate, down, touchTap): the existing context, refreshed, or undefined (#1329). */
  protected inputContext(action: IDeckActionContext, settings: S, event: DialInputEvent): Ctx | undefined;
  /** The one place a context leaves the map; each surface's willDisappear calls it where it deletes today. */
  protected forgetContext(actionId: string): void;
}

export abstract class ReleaseDialSurfaceBase<Ctx extends { action: IDeckActionContext }, S> extends DialSurfaceBase<Ctx, S> {
  /** The gestures this context's release and touch would fire. Called only for a context that exists. */
  protected abstract dialGestures(ctx: Ctx, settings: S): DialGestures;

  /** #269: `none` without a context, else dialGestureShape over dialGestures at getDualPressThresholdMs(). */
  pressShape(action: IDeckActionContext, settings: S): PressShape;
  /** #269: `none` without a context, else touchGestureShape over dialGestures. */
  touchShape(action: IDeckActionContext, settings: S, hold: boolean): PressShape;
}
```

The behaviour each piece keeps:

- **The map.** It is private to the base, and surfaces see it only as `protected get contextsState(): ReadonlyMap<string, Ctx>`. Every surface already reads its map under that name (`get`, `has`, `values`, `size`), so no read changes. A `set`, `delete` or `clear` outside `ensureContext` / `forgetContext` stops compiling, so the one-writer rule holds by construction rather than by a text match. The getter returns the same `Map` object, so a test's `surface["contextsState"]` still reads live state.
- **`ensureContext`.** It does what every copy does today: `get` the context, and if there is one, `refreshContext` it and return it. Otherwise it calls `createContext`, `set`s the result and returns it. Every current creation path builds the whole context, including the hold preview and Replay Control's lazy subscription, and then calls `set` last (`replay-control-dial-surface.ts:1365-1406`, `fuel-dial-surface.ts:1753-1795`). No creation path reads the map for its own id while building. So moving the `set` out of the builder changes nothing. The hold preview's closures and Replay Control's `io` predicate read the map later, at call time.
- **`inputContext`.** It is the 18 copies' body verbatim, still over `hasDialInputContext` (`shared/dial-context.ts:21`), so the drop line's wording does not change. A refresh on input goes through the same `refreshContext`, which keeps rule 11's "refreshed exactly as `ensureContext` refreshes it" true by construction.
- **The press shapes.** They `get` the context and pass it with the event's settings to `dialGestures`. A `has` guard followed by reading the event's settings is the same as a `get` guard followed by the same read. So the 14 surfaces that read the event's settings, Fuel Service and Setup Chassis (which read `ctx`), and Replay Control (which resolves through `resolveDialGesture`) each say which gestures fire in one hook. The guard, the threshold and the flag logic live once.
- **`host`.** It is an abstract property, which each surface already has as a parameter property. The change is `private readonly host` → `protected override readonly host`. The base reads `this.host.logger` at call time, exactly as the copies do, so no constructor changes shape. Fuel Service's three-parameter constructor (`fuel-dial-surface.ts:1028-1036`) is unaffected.
- **Audio Controls extends only `DialSurfaceBase`.** Its presses fire at `dialDown`, and its action declares their shape itself (constraint list above). If it inherited a `release` `pressShape`, that member would be wrong for Audio Controls and would sit there waiting for someone to wire it up. The other 17 extend `ReleaseDialSurfaceBase`. That name says what its `pressShape` always returns, the `release` kind.
- **The convention for a surface on `DialSurfaceBase` alone.** It declares its own `pressShape` / `touchShape` on the surface, guarded on its context like the base's (`none` when `contextsState` has no entry), and its action delegates to them as the other 17 do. Rule 12 says so. Audio Controls is the one named exception, whose shape stays in its action (`audio-controls.ts:249-261`), because moving it onto the surface would add that context guard and change what it returns for a context that does not exist (*Out of scope*). The coverage guard therefore forbids `pressShape` / `touchShape` only on `ReleaseDialSurfaceBase` subclasses.

Why a base class and not composition: the measured duplication is members, not logic. The logic is already shared (`hasDialInputContext`, `dialGestureShape`, `touchGestureShape`). What #1329 and #269 copied were the class members wrapped around that logic, which the actions call (`pressShape`, `touchShape`) or which the surface calls on itself (`inputContext`, 53 call sites). Only inheritance removes those members. Composition renames them into forwarders. With the base:

- The 53 `this.inputContext(...)` and 36 lifecycle `this.ensureContext(...)` call sites stay textually unchanged, because the inherited members keep their names and signatures.
- The press-shape members disappear from the 17 surfaces.
- A future member that every surface needs is one edit to the base.

The coupling cost is bounded because the base owns nothing a surface draws, times or dispatches. The self-drawn surfaces are Fuel Service, Audio Controls, Camera Controls and Black Box Selector. They differ from the dash-box ones in rendering, throttling and gestures, and none of that moves. They fit the base on the same terms as the others: one creation literal, one refresh rule and one gesture hook each.

### 2. It lives in `iracing-actions/src/shared/`, not in deck-core

The 2026-10-20 review judged that the "host-generic half (context lifecycle, gestures) fits beside `dial-gesture` in `deck-core`" (`2026-10-20-architecture-review.md:317`), and the issue repeats it. This spec departs from that, for four reasons:

- **There is no iRacing half to separate.** Nothing in the base reads telemetry, the SDK or a sim event. It is as sim-neutral as `dial-context.ts` and `dial-release.ts`, which already live in `shared/` under the liftability guard (constraint 7). The file's `dial-` prefix puts it under that guard with no test edit. Its imports are deck-core types, `getDualPressThresholdMs` from deck-core, `./dial-context.js` and `./dial-release.js`.
- **The press-shape half reads the build flag** (constraint 2), which deck-core must not see. Splitting the base across two packages would put a class hierarchy across the package seam to save no lines.
- **Every surface test mocks deck-core by hand** (constraint 1). A base exported from deck-core would mean 15 test factories gain a class, or switch to `importOriginal`, in a change whose proof is that the tests do not change. The base's one runtime import from deck-core, `getDualPressThresholdMs`, is one the 17 release surfaces' tests already provide, and it is read at call time.
- **It has one consumer package.** Lifting it when a second action package exists is the move #1013 and #1437 already prepared for. It is a file move, and the guard keeps it possible.

### 3. What moves and what deliberately stays per surface

Moves to the base:

- The context map, private to the base, read through the `protected` `contextsState` getter. Replay Control and Replay Markers rename their `contexts` to it (25 references in the two sources).
- The `ensureContext` scaffold, `inputContext` in full, the one `set`, and the one `delete` through `forgetContext`.
- `pressShape` / `touchShape` and their `none`-without-a-context guard, for the 17 release surfaces.

Stays in each surface:

- **The creation literal and the hold preview (`createContext`).** Each surface's context type is its own. The preview's callbacks draw that surface's preview, and `__FEATURE_DIAL_EXTENDED_GESTURES__ ? createHoldPreview(…) : NOOP_HOLD_PREVIEW` stays at the construction site, as the encoders rule prescribes.
- **The refresh rule (`refreshContext`).** It is abstract, with no default, so a surface states rule 10 explicitly. Action and settings for most surfaces; action only for Fuel Service and Setup Chassis; action only for Audio Controls, whose call sites keep assigning `ctx.settings` as now.
- **Which gestures fire (`dialGestures`).** It is `gestureSlots(dial)` for the 12 plain surfaces, and the variants listed in the table for the rest.
- **`willDisappear` in full, except that its `delete` becomes `this.forgetContext(actionId)` at the same point.** Teardown order is behaviour (constraint 4), and an inherited default would be overridden by 8 of the 18 surfaces, inviting a missing call to the base. Routing the delete through one member still means a future per-context resource held by the base is released in one place.
- **`rotate`, `down`, `up`, `touchTap`, rendering, throttling, `onTelemetry`, `refreshAll`.** In particular, the pure checks some `touchTap`s make before the gate stay as they are: the flag test and the `none` gesture (e.g. `setup-aero-dial-surface.ts:276-282`). They decide whether a dropped touch logs the drop line, and none of them touches `this` (measured).

### 4. The actions' delegating members do not shrink

The surfaces' public signatures do not change (constraint 6), so no action file changes. The 17 delegating `dialPressShape` / `touchPressShape` pairs stay as they are. Each is the seam where the action parses its own schema, `.dial` for most and the whole settings for Fuel Service and Setup Brakes, before handing it to the surface. That parse is the action's job, and the members are two to six lines.

What would remove them is an action-side helper that wires every dial handler member to `this.dialSurface`. That changes the class hierarchy of 18 actions across two base classes (`ConnectionStateAwareAction`, `SimIRacingAction`) and the base-class mocks in their tests. It also changes how `press-shape-coverage.test.ts` recognises a declared member (`press-shape-coverage.test.ts:47-49`). That is a different refactor with a different proof, and it is out of scope here.

### 5. All 18 in one branch, migrated by family; neutrality is proven by unchanged tests plus a guard

One PR, because a half-migrated family is the worst state: two patterns, and a guard that cannot be switched on. Inside the branch, one commit per step, each green on its own files:

1. The base, `shared/dial-surface-base.ts`, its unit test, and `shared/dial-late-input.test-support.ts` (Testing), with no consumer yet.
2. The nine plain dash-box surfaces: Setup Aero, Setup Engine, Setup Fuel, Setup Hybrid, Camera Editor Adjustments, Cockpit Misc, Force Feedback, View Adjustment, Splits & Reference. This is a mechanical recipe: `extends ReleaseDialSurfaceBase`, drop the map, make `host` `protected override`, split `ensureContext` into `createContext` / `refreshContext`, delete `inputContext` / `pressShape` / `touchShape`, add `dialGestures` = `gestureSlots(dial)`, route the delete through `forgetContext`, prune the imports, and add the shared late-input suite's call to the surface's test file.
3. The dash-box surfaces with a hold preview: Setup Brakes (`settings.dial.*`), Setup Traction, and Setup Chassis (authoritative; `dialGestures` reads `ctx.dial`).
4. The self-drawn surfaces: Fuel Service (authoritative; reads `ctx.settings.dial`), Camera Controls, Black Box Selector, and Audio Controls (`DialSurfaceBase` only).
5. The replay surfaces: Replay Control (`resolveDialGesture`; the lazy subscription moves into `createContext` unchanged) and Replay Markers. Both rename `contexts` → `contextsState`, together with the 11 bracket reads in their two test files.
6. The coverage guard (Testing, below), then the rule and `CLAUDE.md` text.

How behaviour neutrality is proven:

- **The existing tests are unchanged.** No existing assertion, fixture or expected value changes. The PR shows that `git diff origin/master...HEAD -- '*.test.ts' '*.test-support.ts'` contains only these permitted edits:
  - the 11 `surface["contexts"]` → `surface["contextsState"]` reads in step 5, which name a private field;
  - three return annotations, `Map<string, unknown>` → `ReadonlyMap<string, unknown>`, on the `contexts()` helpers that read the map: `fuel-dial-surface.test.ts:2735`, `audio-dial-surface.test.ts:902` and `setup-chassis-dial-surface.test.ts:500`. The getter's `ReadonlyMap` is not assignable to `Map`. Fuel's other reads (`:1439`, `:2472`, `:3368`, `:3717`) cast through `unknown` and only call `get`, so they compile unchanged;
  - additive lines only: in each of the 18 surface test files, the import of `describeLateInput` and one call to it with that file's drivers;
  - the new files: `dial-surface-base.test.ts`, `dial-late-input.test-support.ts` and `dial-surface-base-coverage.test.ts`.

  The shared press-shape suite (`shared/press-shape.test-support.ts`, run by all 17 release surfaces) already pins the cases that could drift: no context, flag off, gesture `none`, and stored versus event settings. The six late-input suites, `dial-context.test.ts` and `press-shape-coverage.test.ts` all run unchanged.
- **Test counts are compared.** The PR records the suite's test count before and after. It must be the old count plus exactly the new files' cases and the 18 suites' late-input cases.
- **The late-input rule is proven per surface by behaviour, and per member by structure.** The shared late-input suite runs in all 18 surface test files, against each surface's real input members. It proves the behaviour for every surface, including the 12 that have no late-input test today. The structural guard (Testing) proves the shape of every `rotate` / `down` / `touchTap`: only the allowed pure prelude comes before the gate, and the gate's result is acted on. So a 19th surface, or a later edit that puts a side effect ahead of the gate, fails even before anyone writes its behaviour test. The base's own unit test proves the gate itself. None of the three is enough alone: the base test cannot see a surface that skips the base, the guard cannot see behaviour, and the suite runs only where it is called, which the guard's surface count pins.

Every intermediate commit typechecks. The base is purely additive until a surface extends it, and each family commit migrates whole surfaces.

### 6. Interaction with #1597 and #1072

**#1597** (per-context ordering at the adapters, `2026-11-02-issue-1597-lifecycle-event-ordering.md`) assumes that the surfaces' own defence stays: "`hasDialInputContext` stays as a second defence (tests and the harness drive surfaces directly)" (`:128`, and `:177` under its *Out of scope*). This spec keeps that gate as it is and moves where it is called from. The base assumes no ordering. Under today's unordered delivery the gate drops late input. Under #1597, input after a disappear never reaches the action and input before an appear waits for it, so the gate stops firing in production and still guards direct callers. The base adds no await, so it cannot break #1597's contract that a lifecycle handler never awaits another event of its own context (`:83`). Audio Controls' await of the PTT release before `forgetContext` keeps today's window, in which its context still exists. Under #1597 that window is closed by the exclusive disappear.

The two changes touch different packages: #1597 the adapters, deck-core and plugin-runtime; this one only `iracing-actions`. They share only the prose of rule 11 in `encoders-and-touchscreen.md`. #1597 rewrites it from "Dropping is safe because…" onward. This spec changes the sentence that says each surface calls the gate from its own `inputContext`. Whichever merges second rebases that paragraph, and neither depends on the other.

**#1072** (`CamCarIdx`) assumes the dial path passes `CamCarIdx` through raw, so a missing value reaches `computeTrackOrderTarget`'s `undefined` guard. That read sits in Camera Controls' private rotation and carousel helpers (`camera-dial-surface.ts:1340, 1380, 1454, 1505`), which this refactor does not touch. The coerced read #1072 is about is on the keypad (`camera-controls.ts:1118, 1570`), and no action file changes here. The only shared file is `camera-dial-surface.ts`, in disjoint hunks (lifecycle at `:1013-1262`, helpers from `:1298`). Either can merge first. A dial-side test that #1072 adds is an addition to a test file this spec leaves untouched.

## Rejected alternatives

- **A composed helper the surfaces hold** (`private readonly contextsState = new DialContexts({ create, refresh, gestures, logger })`, a `Map` subclass). It has one real merit: each surface keeps its field name, so the 11 replay test reads stay as they are. But every surface would keep public `pressShape` / `touchShape` forwarders (34 members) and either rewrite its 89 `inputContext` / `ensureContext` call sites or keep private forwarders for them. The next member-level feature would again cost 17 edits. Its `gestures` callback would close over the surface just as an abstract method does, only less visibly.
- **More shared functions, the status quo extended.** This is exactly what #1329 and #269 did. The copied lines are the class members around the functions, and more functions cannot remove members.
- **The base, or its lifecycle half, in deck-core.** Rejected for the reasons in decision 2.
- **One base class whose press shapes Audio Controls inherits unused, or with an optional hook.** An inherited `release` shape on a surface whose presses fire at down would be a trap. It is also a public member that no test pins, because Audio's action never calls it.
- **A default `willDisappear` in the base.** Eight of the 18 surfaces would override it, Audio Controls asynchronously, and an override that forgets the base call leaks the context. `forgetContext` gives the same single removal point with no override.
- **A default `refreshContext` (refresh action and settings).** It would be silently wrong for the three surfaces that keep stored settings authoritative. Rule 10 is a choice each surface should write down.
- **Unifying the actions' dial routing in the same change** (decision 4). It needs a different proof, touches 18 action classes and their tests, and is not needed for the surface-side goal.
- **A `protected` `Map` in the base, with a source-text predicate refusing `contextsState.set(` / `.delete(` in a surface.** The compiler can enforce the one-writer rule through a `ReadonlyMap` view, so a text match that a different spelling (`const m = this.contextsState; m.set(…)`) slips past is the weaker tool. The cost is three test annotations (decision 5).
- **Base field named `contexts`.** That would rename 145 references in 16 surfaces and 12 test reads, against 25 references and 11 test reads for `contextsState`.

## Changes to the repository

- `packages/iracing-actions/src/shared/dial-surface-base.ts` (new) and `dial-surface-base.test.ts` (new).
- The 18 `*-dial-surface.ts` files, as in decision 5. No action file changes and no manifest or PI changes.
- `packages/iracing-actions/src/actions/dial-surface-base-coverage.test.ts` (new) and `packages/iracing-actions/src/shared/dial-late-input.test-support.ts` (new); see Testing.
- The 18 surface test files: the additive `describeLateInput` import and call. Also, in `replay-control-dial-surface.test.ts` and `replay-markers-dial-surface.test.ts`, the 11 field-name reads, and in the Fuel Service, Audio Controls and Setup Chassis surface tests, the three `ReadonlyMap` annotations (decision 5).
- `.claude/rules/encoders-and-touchscreen.md`:
  - Rule 11 (`:85`): the gate is called from the base's `inputContext`; a new surface extends the base rather than writing `inputContext` / `ensureContext`; the coverage guard refuses one that does not.
  - Rule 12 (`:86`): a `ReleaseDialSurfaceBase` surface declares `dialGestures` and inherits `pressShape` / `touchShape`. A surface on `DialSurfaceBase` alone declares its own `pressShape` / `touchShape`, guarded on its context, and its action delegates to them. Audio Controls is named as the one exception, with its shape in the action.
  - Rule 11 also names `shared/dial-late-input.test-support.ts` as what a new surface's tests run, replacing "`fuel-service/fuel-dial-surface.test.ts` is the reference".
  - Rule 10 (`:84`): the authoritative model is a surface's `refreshContext`.
- `.claude/rules/stream-deck-actions.md:176`: the dial action still delegates; the surface's shape comes from `ReleaseDialSurfaceBase`.
- `packages/iracing-actions/CLAUDE.md`: the `dial-context.ts` bullet (`:82`, "Each surface calls it from its private `inputContext`"), a new `dial-surface-base.ts` bullet, and the *Dial surfaces* paragraph (`:107`).
- No changelog fragment (nothing user-facing), no website page, and no Architecture page change: no package boundary or seam moves.
- Review: `/code-review high` (ordinary domain code). The second read applies, because the #1329 input gate is a gate and this change moves it.

## Testing

### Automated

- **`shared/dial-surface-base.test.ts`, the base's behaviour, over a minimal concrete subclass with spy hooks:**
  - `ensureContext` creates once and refreshes after that, with `createContext` called once and `refreshContext` on every later call.
  - `inputContext` on an unknown id returns `undefined`, calls neither hook, leaves the map empty, and logs exactly `Dial rotate dropped: no context for <id> (it has disappeared)` at debug.
  - `inputContext` on a known id refreshes and returns it.
  - After `forgetContext`, a `rotate`, `down` or `touchTap` through `inputContext` is dropped and re-creates nothing. This is the family-wide late-input case.
  - `pressShape` / `touchShape` are `none` with no context and never call `dialGestures`. With a context, they pass the stored context and the event's settings to `dialGestures`. They follow `dialGestureShape` / `touchGestureShape`, flag off included.
  - `gestureSlots` maps the four slots.
  - `contextsState` returns the live map: an entry `ensureContext` adds is visible through it, and one `forgetContext` removes is gone.
- **`shared/dial-late-input.test-support.ts`, the shared late-input suite**, on the `press-shape.test-support.ts` pattern. It is called from all 18 surface test files, so it runs with each file's mocks against the real surface. `describeLateInput(suite)` takes these drivers:
  - `appear(id)` and `disappear(id)`;
  - `rotate(id)`, `down(id)` and `touchTap(id, hold)`, the last omitted for Audio Controls with the reason named at its call;
  - `contexts()`, reading `surface["contextsState"]`;
  - `sent()`, the file's spies on what a surface sends, e.g. `tapBinding` and `setDialCanvas`.

  The suite runs under fake timers. For each of rotate, down and touchTap (both `hold` values, with the extended gestures on and gestures that act), sent after `willDisappear`, it asserts three things: no entry for the id, `vi.getTimerCount()` unchanged from before the event, and no call on any `sent()` spy. A live case asserts the same drivers do reach a surface that has appeared, so the suite cannot pass on drivers that never arrive. The six existing late-input suites stay as they are.
- **`actions/dial-surface-base-coverage.test.ts`, a source-text guard like `press-shape-coverage.test.ts`:**
  - It finds every `actions/*/*-dial-surface.ts` and checks that their number equals the number of `Encoder` actions in the Elgato manifest (18). This is a positive find, and it also catches a new dial whose surface is named otherwise.
  - Each surface's class `extends ReleaseDialSurfaceBase<`. Audio Controls is the only allowed `extends DialSurfaceBase<`, through a named allow-list entry with its reason.
  - No surface declares an `inputContext`, `ensureContext` or `forgetContext` member, or imports `hasDialInputContext`. A `ReleaseDialSurfaceBase` subclass also declares no `pressShape` / `touchShape`. A `DialSurfaceBase`-only surface may, per rule 12. There is no text predicate for map writes, since the private map and its `ReadonlyMap` getter make one a type error (decision 1).
  - **The input members are found, multi-line signatures included.** The finder matches `rotate(`, `down(` and `touchTap(` at member indentation and reads to the signature's closing `) {` / `): … {`, however many lines it spans. It must find `rotate` and `down` in all 18 surfaces and `touchTap` in 17. Audio Controls is the named absence, which fails the test if it gains one. The multi-line cases today are `fuel-dial-surface.ts:1105` (`rotate`) and `:1274` (`touchTap`), and `setup-brakes-dial-surface.ts:278` (`rotate`).
  - **The gate is checked by statement shape, not by "the first `this.`".** The body's statements, comments stripped, must open with an allowed prelude and then the gate.
    - The prelude may contain only these statements, in this order, each optional:
      - `if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;`
      - `const gesture = hold ? <s>.longTouchAction : <s>.tapAction;`, read from the event's settings parameter (`dial`, `settings` or `settings.dial`);
      - `if (gesture === "none") return;`
    - The next statement must be exactly one of the two gate forms:
      - `const ctx = this.inputContext(action, <s>, "<event>");` followed directly by `if (!ctx) return;`
      - `if (!this.inputContext(action, <s>, "<event>")) return;`

      `<event>` must match the member.
    - `this.ensureContext(` appears nowhere in the member.

    Measured at `c62f1eaae`, all 53 input members already match:
    - all 36 `rotate` / `down` members have no prelude and use the `const ctx` form;
    - 4 `touchTap`s (Fuel Service, Replay Control, Replay Markers, Setup Chassis) have the flag line alone and use the `const ctx` form;
    - 12 `touchTap`s use the three-statement prelude and the `if (!this.inputContext(…))` form;
    - Black Box Selector's `touchTap` combines the three-statement prelude with the `const ctx` form.
  - **Every surface test file calls `describeLateInput`.** For each of the 18 surfaces, its `*-dial-surface.test.ts` imports and calls the suite once. This ties the behaviour suite to the same surface count.
- **The guard's positive control.** Each predicate runs on planted source and must flag it:
  - a class with no `extends`;
  - an `inputContext(` member;
  - a `pressShape(` member on a `ReleaseDialSurfaceBase` subclass (the same member on a `DialSurfaceBase`-only plant must pass);
  - a `rotate` that calls `this.ensureContext(` first;
  - a module call before the gate: `renderSomething(action);` or `void flush();` ahead of the gate, which a "first `this.`" test would miss;
  - an ignored gate result: `this.inputContext(action, dial, "rotate");` as a bare statement, followed by work;
  - a gate whose event names another member (`"down"` in `rotate`);
  - a multi-line signature: a `rotate(` whose parameters span four lines must be found and judged, not skipped, so a body with a call before the gate still fails;
  - a surface test file without a `describeLateInput` call.

  A planted migrated surface, with both gate forms and the full prelude, must pass. A predicate that cannot fail proves nothing.
- **Unchanged and green, apart from the permitted edits of decision 5:** all 18 surface suites, the six late-input suites, the shared press-shape suite (17 surfaces), `press-shape-coverage.test.ts`, `dial-context.test.ts`, `dial-sim-agnostic.test.ts`, and every action test. Also `pnpm typecheck`, since the test files are typechecked. That covers the bracket reads of the inherited `protected` getter, the three `ReadonlyMap` annotations, and a deliberate `this.contextsState.set(…)` in a scratch surface. That last one must fail to compile; it is checked once by hand and not committed. The full green set (`install` → `build` → `typecheck` → `format` → `lint` → `test`) is read in full, plus the test-count comparison from decision 5.

### Manual (Niklas, Stream Deck+ and a Mirabox knob)

**Every surface, Stream Deck+:**

- On a page with the dial, the name card shows in the Stream Deck app and the strip draws.
- Rotate both ways.
- A short press fires the Press slot, and a long press fires the Long-press slot.
- Tap and Long Touch fire their slots.
- A change in the Property Inspector applies at once.
- With press sounds on **Both**:
  - a short release with a Press gesture set gives one bleep;
  - with a Long-press gesture set, a double bleep comes at the threshold;
  - with every slot on None, nothing sounds.
- Flip to another page and back: the dial draws and works again.
- Turn the dial while flipping away: nothing errors in the log. At debug, the `Dial rotate dropped: …` line may appear, worded as before.

**Every surface, Mirabox knob:**

- Rotate.
- One push fires Press exactly once, with one bleep and never a long one.
- The knob screen draws.
- Page flip and back.

**Per family, on top:**

- **Plain dash-box** (Setup Aero, Engine, Fuel, Hybrid, Camera Editor Adjustments, Cockpit Misc, Force Feedback, View Adjustment, Splits & Reference): the common checks only. On a setup dial, the live value still updates while driving.
- **Dash-box with a hold preview** (Setup Brakes, Setup Traction, Setup Chassis), and also Camera Controls, Fuel Service, Replay Control and Replay Markers:
  - holding past the threshold shows the preview, and releasing acts and reverts it;
  - flipping the page mid-hold leaves no stuck preview when you come back.
- **Settings kept by the plugin** (Setup Chassis Toggle Spring Side, Fuel Service Switch Mode):
  - press twice quickly; the second press flips back;
  - the next press sound follows the switched setting, not the stale one.
- **Fuel Service:** the dialed value seeds from the pit request on appear.
- **Camera Controls:** the side previews still match what a detent selects.
- **Black Box Selector:** rotating walks the boxes, and a press shows one.
- **Audio Controls:**
  - Push to Talk holds while pressed and releases on release;
  - flipping the page while holding releases it;
  - Mute's press sound is unchanged (its shape comes from the action);
  - on the Mirabox knob, Push to Talk does nothing, as before.
- **Replay Control and Replay Markers, in a replay:**
  - the busy look appears on a jump;
  - with two Replay Control dials on screen, flip one away; the other still redraws the paced search's count;
  - with both gone and back, it works again.

## Out of scope

- **Moving `down`, the preamble of `up`, `onTelemetry` or `refreshAll` into the base.** They are measured above, and they are the next candidates. But `up` is the gesture state machine, and its hold-preview disarm must precede every early return (`encoders-and-touchscreen.md`, *The hold preview* trap 4). Rendering differs for the self-drawn and replay surfaces (Fuel's leading/trailing flush, the replay surfaces' `IconUpdateThrottle`). Moving either changes behaviour-bearing code in a bug-fix-only release, so it needs its own spec.
- **Unifying the actions' dial routing and delegating members** (decision 4). The 17 delegating `dialPressShape` / `touchPressShape` pairs remain in the actions. So a #269-shaped feature, one that adds an `IDeckActionHandler` member for dials, still costs an edit in every dial action even though the surface side becomes one edit. That is a candidate for a later issue, to be filed if a third handler-level feature arrives.
- **Lifting the base to deck-core or a new package** (decision 2). That is a file move once a second action package exists.
- **Audio Controls' dial press shape ignoring whether a context exists.** Its action returns `tap` / `none` with no context check (`audio-controls.ts:249-254`), unlike the 17 surfaces. Moving it onto the surface, as rule 12 now asks of a new `DialSurfaceBase`-only surface, would add that guard and change what it returns for a missing context. That is behaviour, and this change keeps it. Audio is rule 12's named exception until a change that means to alter it.
- **#1243's table-driven Audio Controls presses.** It is untouched; it will rebase onto `DialSurfaceBase` if it lands later.
- **The test files' relative imports of `deck-core/src/dial-gesture.js`** (`2026-10-20-architecture-review.md:314`).
- **#1597's ordering and #1072's `CamCarIdx` decision** (decision 6).

## What the code could not settle

- The review's 1,930-line figure cannot be re-measured without `dup.mjs`, so the PR reports member spans before and after instead.
- The base relies on two TypeScript behaviours, and neither is exercised anywhere in the package yet:
  - a test's `surface["contextsState"]` bracket read of an inherited `protected` getter type-checks, as it does for a `private` field today;
  - `noImplicitOverride` demands `override` on a parameter property that implements an abstract property.

  Step 1 of the migration confirms both with `pnpm typecheck` on the first migrated surface before the recipe is handed out.
