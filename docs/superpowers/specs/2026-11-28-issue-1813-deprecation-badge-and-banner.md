# Deprecated actions and modes: a corner badge and a PI banner

> **Issue:** [#1813](https://github.com/iracedeck/iracedeck/issues/1813) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

**Prerequisite:** #1670 (dial screens draw through one funnel in `BaseAction`) merges first. It is unmilestoned today; this spec asks for it in 3.10.0 (Open questions, 1). The key half of this spec does not need it, the dial half does.

## Settled with Niklas (2026-11-28), not re-opened here

- A small badge in the key's top-right corner. It yields to the "A" automatic-mode badge when both apply. The top-left stays the disconnected badge, the centre the #612 ⚠, so this badge must look distinct from both.
- Never blocking: a deprecated key or dial works exactly as before, with no popup, confirm or extra press.
- A Property Inspector banner naming the replacement (action and Mode) and the steps to swap the key. It always shows.
- A global setting, "Show deprecation badges", default on, in the Settings window. The banner ignores it.
- 3.10.0 scope: Replay Navigation, Replay Speed, Replay Transport, Camera Cycle (Legacy), and #1806's moved Camera Controls car modes.

## Decision

### 1. One registry, in `@iracedeck/app-constants`

The registry is data plus one pure matcher, in `app-constants/src/deprecations.ts`. It lives there because both readers need it and that is the one package both already import: deck-core's render path (in the plugin) and the PI banner (bundled into `pi-components.js`). It holds no code that knows a sim, and it imports nothing, so the leaf stays a leaf. (`app-constants` already carries action-level constants the PI shares, such as `STANDARD_CAMERA_GROUP_OPTIONS`.)

```typescript
/** Where a deprecated value is stored, on which surface. */
export interface DeprecatedSetting {
  readonly surface: "key" | "dial";
  /** Dotted paths into the context's own settings; the rule matches when ANY holds one of `values`. */
  readonly paths: readonly string[];
  /** The value the action reads when a path holds nothing (its schema default). */
  readonly unsetValue: string;
  /** Every stored spelling that means the deprecated mode, legacy aliases included. */
  readonly values: readonly string[];
}

/** What to use instead: an action, and the value and PI label of the choice to make in it. */
export interface DeprecationReplacement {
  readonly actionUuid: string; // what the tests key on: registration, manifest name, PI template
  readonly actionName: string; // "Replay Control", as the deck software lists it
  readonly choice?: { readonly field: "Mode" | "Gesture"; readonly value: string; readonly label: string };
}

export interface Deprecation {
  readonly id: string; // stable, kebab-case: "replay-navigation-next-lap"
  readonly actionUuids: readonly string[];
  readonly deprecatedIn: string; // "3.10.0"
  /** Absent: the whole action, on every surface and in every mode. */
  readonly setting?: DeprecatedSetting;
  readonly replacement: DeprecationReplacement;
}

export const DEPRECATIONS: readonly Deprecation[];

/** The rules that hold for one context's settings on one surface, most specific first. Pure; never throws. */
export function matchDeprecations(
  rules: readonly Deprecation[],
  surface: "key" | "dial",
  settings: unknown,
): readonly Deprecation[];
```

- **One rule, one replacement.** A whole action is a rule with no `setting`. A mode is a rule with a `setting`; it may list several stored values only when they share one replacement (a canonical value and its legacy aliases).
- **A rule exists only where there is something to move to.** A mode with no equivalent in the replacement action is not marked: a badge that cannot say "use this instead" only worries the user. So "deprecate Replay Navigation" in 3.10.0 means a rule per Replay Navigation mode that Replay Control covers. Which modes those are is a product call (Open questions, 2).
- **Most specific first.** `matchDeprecations` returns the setting rules before the whole-action rule. The banner names the first one's replacement. This is what makes Camera Cycle (Legacy) read right: the whole action points at Camera Controls, but a legacy key set to Cycle Car points at Replay Control, since that mode has left Camera Controls too.
- **Matching reads the raw stored settings.** `settings` is the context's raw object (`BaseAction.getContextSettings`, or the PI's settings). A path that holds nothing reads as `unsetValue`. A non-object, a throwing getter or a non-string value matches no setting rule. Raw reading is why `values` lists aliases explicitly: Camera Controls' dial reads a stored `"car"` as `car-number`, and the key's legacy `focus-on-exiting` is rewritten only at appear.
- **Adding a deprecation later is one entry**, plus the tests below picking it up. #1806's entries are about a dozen lines (§6).

**Held to the code by tests in `iracing-actions`** (`deprecations.test.ts`), because only that package can see both the registry and the actions:

- every `actionUuids` entry and every `replacement.actionUuid` is registered in `SHARED_ACTIONS`, and `replacement.actionName` equals that UUID's manifest `Name` in all three plugin manifests (these checks live in `plugin-runtime`'s `actions.test.ts`, since `iracing-actions` cannot import the package above it);
- every `values` member, written at each of its `paths` into `{}`, parses through the owning action's settings schema to the rule's canonical value (the first of `values`), so a value the schema would silently `.catch` to its default fails;
- `unsetValue` equals what the schema reads for `{}`;
- every `choice.value` is an option value in the PI template of `replacement.actionUuid` (found through the manifest's `PropertyInspectorPath`), and `choice.label` is that option's exact text, so the banner names what the user will see in the dropdown;
- `id`s are unique, `deprecatedIn` is a semver string.

### 2. The registry reaches the action by injection

deck-core stays free of the registry's contents. `BaseAction` gains:

```typescript
/** Registration-time: the deprecation rules for this instance's action UUID. Called once, before the adapter registers it. */
setDeprecations(rules: readonly Deprecation[]): void;
```

`plugin-runtime`'s `registerActions` already holds each entry's `uuid`; it calls `instance.setDeprecations(DEPRECATIONS.filter((r) => r.actionUuids.includes(uuid)))` on every instance, before `withPressSounds` and `adapter.registerAction`. `ActionRegistration.create` (`plugin-runtime/src/types.ts`) is narrowed from returning `IDeckActionHandler` to returning `BaseAction`, which every registered class already extends, so the call is unconditional and typed: a future registration of something else fails to compile rather than silently getting no rules (an `instanceof` check would skip it without a word). Each registration creates its own instance (Camera Controls and Camera Cycle (Legacy) are two `CameraControls` objects), so an instance's rules are exactly its UUID's.

- **Why not teach the context its UUID** (`IDeckActionContext.actionUuid`): it would widen SEAM 2 on all three adapters for a fact the registration already has.
- **Why not a constructor argument:** 40 action constructors take `(logger)`; one registration-time setter changes none of them.

### 3. The key badge: decided in `BaseAction`'s one funnel

`decorateKeyImage` (#1599) becomes the place for both looks:

1. the image, unchanged;
2. the disconnected look, when `showsDisconnected(contextId)` (#1599: dim layer, then the plug badge top-left);
3. the deprecation badge, top-right, when `showsDeprecation(contextId, "key")`.

```typescript
/** `showDeprecationBadges` is on and a rule matches this context's own settings on this surface. */
protected showsDeprecation(contextId: string, surface: "key" | "dial"): boolean;
```

- **Order:** the deprecation badge is drawn last, over the disconnected dim, so on a disconnected key both badges read at full strength and neither hides the other (opposite corners).
- **Yields to the "A" badge:** the badge is not drawn when the image carries the automatic-mode badge. Every "A" badge gets one attribute, `data-ird-auto-badge`, exported from `icon-composer` as `AUTO_BADGE_ATTRIBUTE`: the three key icons that draw one today (Auto Compute FFB Force, the two Auto Set Mic Gain icons) and the Camera Controls dial's Auto Group marker. The badge function tests for the attribute in the image's text. It changes no pixel of those icons; their previews regenerate. A test scans `packages/icons` for an "A" badge drawn without the attribute (a `<text>` whose content is `A` inside the top-right quarter of the artwork), with a planted positive control. None of the 3.10.0 rules covers a key that draws an "A" badge; the yield exists for later entries and for a Camera Controls dial that owns Auto Group while on a moved mode.
- **A throw drops only its own decoration.** The funnel asks each decision separately; one that throws is logged at debug and counts as `false`, and the other is still drawn. A deprecation check that throws never strips the disconnected look, and neither can ever cost a key its image.
- **One pass.** The funnel collects the overlays that apply and hands them to one icon-composer helper, which decodes the image once, inserts every overlay before the root's last `</svg>` in order, and encodes once. With only the disconnected overlay, the output is byte-identical to `applyDisconnectedLook`'s today.
- **Redraws:** a global-settings change already re-sends every key through `refreshAllImages`, so toggling the setting needs nothing new. A per-key settings change (the user moves off the deprecated Mode) is redrawn by the action's own `onDidReceiveSettings`, which calls `super` first (`stream-deck-actions.md`), so the funnel decides against the new settings.
- **What is not decorated**, as for the disconnected look: the flag-overlay frames (the badge returns with the restore) and the Stream Deck + name card.
- **The badge** lives in `icon-composer`, beside the disconnected look: `deprecationOverlaySvg(box, options?: { badgeScale?: number })` builds the overlay for a canvas, and `applyOverlays(svg, builders)` is the shared one-pass helper (the decode, the root-canvas read, the insert before the last `</svg>`, the encode), which `applyDisconnectedLook` becomes a one-builder call of, so the two cannot drift on data URIs or canvases. The "A"-badge yield sits in the deprecation builder: it returns no overlay when the decoded image carries `AUTO_BADGE_ATTRIBUTE`. Without options the badge is authored for the 144×144 key, anchored top-right, mirroring the disconnected plate's inset (a 40×40 plate at x 96–136, y 8–48 is the starting size). It obeys the same shape set as the disconnected badge (`rect`, `circle`, `polygon`, `path`, plain fills, opacity, translate/scale/rotate; no text, filter, mask, gradient, style or class), so it reads with `pngRasterization` off (`svg-platform-compatibility.md`).
- **All three hosts:** the funnel runs before every adapter's `setImage`, so Stream Deck, Stream Dock and Ulanzi keys get it with no adapter change.

### 4. The dial badge: decided in #1670's funnel

A dial screen gets the same badge through #1670's `setDialImage`, with the record-and-redraw shape #1671's spec designed for the disconnected look. This issue is that record's first reader, so it builds it, under names general enough for both looks, and #1671's spec is amended in the same `docs(specs)` commit to extend it rather than build its own (the amendment is listed under *Amends* below):

- `setDialImage(action, image)` decides each dial decoration separately (a throw counts as `false` for that one alone), records `{ action, image, decorations }` for a live context with the undecorated image, and sends the image through the one-pass `applyOverlays` with the dial's badge scale.
- `refreshDialDecorations(only?: contextId)` re-sends a recorded frame, decorated afresh, only for a context whose `decorations` changed. `BaseAction` calls it after `refreshAllImages` on every global-settings change, and for one context from `onDidReceiveSettings`, after it stores the new settings. A dial whose state did not change is not re-sent, so a settings write costs a dial nothing extra (no extra Elgato feedback, no extra knob rasterisation).
- `decorations` is a small record (`{ deprecated: boolean }` here), so #1671 adds `disconnected` to it and to the comparison. `onWillDisappear` drops the context's record. `showsDeprecation` takes the surface from the start, which is the parameter #1671 gives `showsDisconnected`.
- **The super-call order is enforced here**, moved from #1671's spec: a dial's first frame is recorded and decided against that dial's own settings only if the owning action awaits `super.onWillAppear(ev)` before its surface's `willAppear`, and `super.onDidReceiveSettings(ev)` before the surface's `didReceiveSettings`; otherwise it is decided against `undefined` settings, which match no setting rule. All 18 Encoder actions do this today. `actions/dial-surface-base-coverage.test.ts` gains the rule #1671 described (the `super.<member>(…)` call before the first `this.<…DialSurface field>` call, read with the guard's `scanSource`), with a planted swapped-order source and one with no super call as positive controls.
- **Badge scale per canvas:** `CORNER_BADGE_SCALE: Readonly<Record<DialCanvasId, number>>` in `deck-core/src/dial-canvas.ts`, exhaustive, so a new profile fails to compile until it has one. #1671 uses it for the disconnected badge in place of its `DISCONNECTED_BADGE_SCALE` (its §3 measured the left corner; the right corner mirrors it). Starting values, from #1671's measurements mirrored: strip (200×100) 0.694, which clears the right side mark by about 2 px and sits beside the Auto Group marker's slot; knob (176×112) 0.55, since the knob's right side mark would overlap a larger plate. The values are total scales on the 144 badge, as #1671 measured them. **Niklas's pick (2026-11-28): the hourglass, at the biggest size offered.** The review page applied its dial numbers as multipliers on the canvas fit rather than as totals, so its biggest options (totals of about 0.556 on the strip and 0.506 on the knob) were smaller than the largest that fits (0.694 and about 0.58). When the dial half is built, it shows the largest that fits on a corrected review before committing the values.
- **Ulanzi** has no dial canvas (#1013) and draws nothing. The name card is not decorated.
- **Without #1670** the dial half has no single place to live. Drawing it in Camera Controls' dial surface alone would serve 3.10.0's one dial case and leave every later dial deprecation to a per-surface copy, the class #1670 exists to close, so it is not offered.

### 5. The global setting

```typescript
showDeprecationBadges: z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(true)
  .catch(true),
```

- A new field, so every install, new and existing, reads the default (`true`) with no migration; the field joins the published schema contract.
- **Settings window:** a card on the Appearance tab, after Disconnected Keys, in a new partial `global-deprecation-badges.ejs`: one `sdpi-checkbox setting="showDeprecationBadges" default="true" global`, and a line of supporting text. Text in Open questions, 3.
- **The banner never reads it.** A user who has hidden the badges still learns what replaces a key the moment they open its PI.

### 6. The PI banner: one auto-injected component

`ird-deprecation-notice`, in `pi-components`, injected by `head-common.ejs` directly after the `ird-warnings` strip, so every action PI gets it with no per-template markup, now and for every future action. It renders nothing on the settings window and on any page with no matching rule.

- **Which action:** `actionInfo.action`, the UUID from the PI's registration (`streamDeckClient.getConnectionInfo()`, the same call `irdResolveController` makes). All three hosts supply it: Elgato and the Mirabox host natively, the Ulanzi bridge in the connection info it synthesises. This is what separates Camera Controls from Camera Cycle (Legacy), which share `camera-focus.html`.
- **Which surface:** the controller, `Encoder` or `Knob` being a dial. That rule lives today in `dial-controller.ejs`'s inline script, which only the 18 dial PIs include, so the legacy replay PIs have no `irdResolveController`. It moves into the bundle: a `getConnectionInfo()` helper and the controller classification beside `sendToPlugin` in `components/sdpi-client.ts`, with `window.irdResolveController` installed from there on bundle load as `irdPoll` is. `dial-controller.ejs` keeps only `irdApplyDialView`, and `dial-pi-knob-gating.test.ts` follows. The banner and the dial PIs then share one copy of the rule.
- **Which settings:** the component reads every path the action's rules name through sdpi's `useSettings` getters, never its setters, so it never saves. sdpi notifies `useSettings` callbacks only for `didReceiveSettings`, not for the PI's own saves; a save does write the shared settings object the getters read, after the control's 250 ms debounce. The component therefore re-reads its getters on the shared page poller, `window.irdPoll`, as the PI templates watch their selects (#903), and on every `didReceiveSettings`, so a Mode changed in this PI clears or raises the banner about a quarter of a second later. It reads nothing in response to a DOM event (`ird-enable-feature`'s lesson).
- **What it says:** the first matching rule's replacement, and the steps. Wording in Open questions, 3. Every string it writes is `textContent`.
- **Interaction with #1806's hide helper:** that helper keeps a moved option only while it is the stored value, so a user on a moved mode sees the option, marked "(moved to Replay Control)", and this banner above it. Once they pick another mode, the option leaves and the banner clears at the next poll.

### 7. The 3.10.0 entries, and the order with #1806

Draft entries, to be confirmed by Niklas where a mapping is a judgement (Open questions, 2):

| Deprecated | Rule | Replacement (action · choice) |
| --- | --- | --- |
| Replay Navigation | per `navigation` value Replay Control covers: next/prev session, lap, incident; `jump-to-start` → Jump to Beginning; `jump-to-end` → Jump to Live | Replay Control · same-named Mode |
| Replay Speed | `direction` increase / decrease | Replay Control · Increase Speed (Slow-Mo) / Decrease Speed (Slow-Mo) |
| Replay Transport | per `transport` value: `play`, `pause` → Play / Pause; `stop`, `fast-forward`, `rewind`, `slow-motion`, `frame-forward`, `frame-backward` → the same-named Mode | Replay Control |
| Camera Cycle (Legacy) | whole action | Camera Controls · (the key's own Mode) |
| Camera Controls and Camera Cycle (Legacy), key, `target` | `cycle-car`, `cycle-track-order`, `focus-your-car`, `focus-on-leader`, `focus-on-incident`, `focus-on-most-exciting` (+ `focus-on-exiting`), `focus-select-car`, `switch-by-position`, `switch-by-car-number` | Replay Control · the Mode #1806 adds or names |
| Camera Controls, dial, `dial.mode` | `car-number` (+ `car`), `race-position`, `track-order` | Replay Control · its dial Mode |
| Camera Controls, dial, the four gesture slots | `focus-my-car`, `focus-on-leader`, `focus-on-incident`, `focus-on-most-exciting` | Replay Control · Gesture |

Replay Navigation's `set-play-position`, `search-session-time` and `erase-tape` have no Replay Control mode and get no rule (§1).

**A visible consequence of `unsetValue`:** the Camera Controls dial's schema default is `car-number`, so a dial that never stored a mode matches the `dial.mode` rule and shows the badge. That is right (it does run Cycle by Car #), and #1806's decision 5 persists the resolved mode at first appearance, so after #1806 only an old dial reads `car-number` that way.

**Order:** #1670 → #1813 → #1806's Camera Controls rows. #1813 then lands the mechanism and the four legacy actions; #1806 adds its rows (about a dozen lines in `deprecations.ts`, plus the Replay Control option labels its own PI already gains), and its PR carries the website note for the moved modes. If #1806 merges first instead, #1813 adds those rows itself. Both edit `BaseAction`'s neighbourhood only through #1761 (`updateSettings`); #1813's change is to the image funnel, not the settings write, so the two meet in one file but not in one function, and whichever lands second rebases.

### 8. Where the parts live, and the second sim

`app-constants` gains the registry's types, data and matcher; its `CLAUDE.md` names them under *What it owns*. "Sim-neutral" for that package means it imports no sim (`eslint.config.js`), and it already carries action-level data the PI shares; the types and the matcher know no sim, and a second sim's actions would add entries. deck-core gets the mechanism only (the funnel's decision, the dial record, `CORNER_BADGE_SCALE`); `IDeckActionContext` and `IDeckPlatformAdapter` do not change. No new edge enters the internal dependency graph: deck-core, pi-components and plugin-runtime already import `app-constants`.

### Amends

The `docs(specs)` commit that adds this spec also amends `2026-11-09-issue-1671-dial-disconnected-look.md` (unshipped, so free to edit): its §2 record, redraw and scale become this spec's `{ action, image, decorations }`, `refreshDialDecorations` and `CORNER_BADGE_SCALE`, extended with `disconnected`; its super-call-order rule is marked as landed with #1813; and its `applyDisconnectedLook(svg, { badgeScale })` becomes a builder passed to `applyOverlays`.

## Review page

**"Deprecation badge (#1813)"**, a private Artifact built with the `review-page` skill before any badge is committed. It shows, on a real key icon (a Replay Transport key, a Replay Control key for contrast) and on both dial canvases (a Camera Controls dial on Cycle by Car #, on the strip and on the knob):

- three candidate badges, each on its own plate colour chosen to stay distinct from the disconnected red, the ⚠ yellow and the "A" amber: a swap arrow, an hourglass and an arrow leaving a box;
- each at the starting size and one step smaller;
- with the disconnected look on as well (both corners);
- with the #612 ⚠ (a Camera Controls key with its binding unset);
- the dial scales one step either side of the starting values;
- the banner, rendered at the PI's width, for a whole-action rule and a mode rule;
- the Settings window card.

## Open questions for Niklas (through the PO)

1. **#1670 into 3.10.0**, ahead of this issue, as the dial half's prerequisite. Its spec is on `master` and the change is mechanical (18 canvas sites and 17 name-card sites through two `BaseAction` members, plus a guard). Recommended: yes.
2. **Which legacy modes count as replaced.** The table in §7 is a draft. The judgement calls: Replay Transport's separate Play and Pause both pointing at the one Play / Pause toggle; Replay Navigation's Jump to End pointing at Jump to Live; the three Replay Navigation modes with no home staying unmarked.
3. **All user-facing text**, drafted here and approved before the PR:
   - Setting label: "Show deprecation badges". Card title: "Deprecated Keys". Supporting text: "Keys and dials that are being replaced show a small badge in the top-right corner. They still work as before. Their Property Inspector says what replaces them."
   - Banner, mode rule: "**This Mode is being replaced.** It still works, but will be removed in a future release. Use **Replay Control** with Mode **Next Lap** instead: add a Replay Control key in place of this one, set its Mode to Next Lap, then remove this key."
   - Banner, whole action: "**Replay Transport is being replaced.** It still works, but will be removed in a future release. Use **Replay Control** with Mode **Play / Pause** instead: …" (same steps).
   - Website: a short "Deprecated actions and modes" page under Features listing each entry and its replacement, a line on each replacement's page, the setting on the Settings page, and the changelog fragment.
4. **The badge's look and size**, on the review page.

## Alternatives rejected

- **A `deprecated` flag in each action class.** Deprecation would then be spread over the actions, the PI could not read it without a build step, and no test could list them all.
- **The registry as generated JSON beside `action-comms.json`.** A generator and a freshness test for data both readers can import directly.
- **The plugin pushing the banner's content to the PI** (`sendToPropertyInspector`). It needs a PI-appearance event on every host and a second channel; the PI already has the settings and the UUID.
- **Matching through each action's schema** (a per-action hook returning the parsed mode). Exact, but the PI cannot run the plugin's schemas, so the two sides would match differently; listing aliases explicitly, held by the schema-parse test, keeps one matcher.
- **A badge that moves corners when the "A" badge is present.** Settled: it yields.
- **Marking modes that have no replacement.** A badge with nothing to move to (§1).
- **A per-key opt-out.** Settled as one global setting.

## Out of scope

- Removing any deprecated action or mode.
- The disconnected look on dials (#1671), beyond leaving its record slot (§4).
- A badge on the Stream Deck + name card, the flag-overlay frames, or Ulanzi dials.
- Telling the user anywhere but the key, the dial and the PI (no log banner, no Settings-window list of deprecated keys on the deck).
- Hiding deprecated modes in the PI: #1806's helper does that for its modes; the legacy actions are already hidden from the actions list.

## Testing

- **app-constants:** `matchDeprecations` on whole-action and setting rules; an unset path reads `unsetValue`; aliases match; any of several paths matches; a non-object, a getter that throws, a number at the path match nothing; setting rules come before the whole-action rule.
- **iracing-actions `deprecations.test.ts`:** the registry checks in §1, run over every entry, with a planted bad entry per check proving each one fails.
- **icon-composer:** `applyOverlays` with the deprecation builder on raw SVG and data URIs, a nested `<svg>`, a viewBox with a non-zero origin, `badgeScale`; the input returned unchanged for a PNG, a malformed URI, and (for the deprecation builder) an image carrying `AUTO_BADGE_ATTRIBUTE`; two builders inserted in order with one decode; the shape-set guard over the badge's markup; `applyDisconnectedLook`'s output byte-identical to before, over the existing fixtures.
- **icons:** every icon drawing an "A" badge carries `AUTO_BADGE_ATTRIBUTE`, with a planted unmarked one reported.
- **deck-core:** the funnel draws the badge only when the setting is on and a rule matches that context's own settings; two keys of one action on different modes decide independently; the badge is drawn over the disconnected look; a throwing deprecation decision still draws the disconnected look, and the reverse; toggling the setting re-sends keys and only the dials whose state changed; a per-context settings change re-decides that dial; a disappeared context's dial record is dropped; the flag frames and the name card stay undecorated.
- **iracing-actions:** the super-call-order rule in `dial-surface-base-coverage.test.ts`, with its two planted controls. Geometry (`shared/dial-corner-badge-geometry.test.ts`): at each canvas's `CORNER_BADGE_SCALE`, the top-right plate does not intersect `renderDialBox`'s label, value, right side mark (`sideMarkGeometry`) or centred ⚠, nor the title and neighbours of Camera Controls' own surface; as a positive control, the key's scale on the knob reports the side-mark overlap.
- **plugin-runtime:** `registerActions` hands each instance exactly its UUID's rules, the two Camera Controls registrations included; the registry's UUID and manifest-name checks (§1).
- **pi-components:** `irdResolveController` from the bundle answers as the partial's did (Encoder, Knob, Keypad, a throw); the dial PIs still switch views.
- **settings:** the new field's default, coercion of `"true"` / `"false"` and `.catch`.
- **pi-components:** `ird-deprecation-notice` renders for a matching UUID and setting, renders nothing on the settings window, on a non-matching mode and with no rules; follows a Mode change made in the same PI through the poller; never calls a setter; reads the dial's paths on an Encoder or Knob controller; head-common injects it once.
- **Dispatch unchanged:** a key and a dial of each deprecated action and mode press, turn and gesture exactly as before (existing suites, plus one test per legacy action asserting its press path with a matching rule installed).
- **Manual (Niklas):** on Stream Deck, a Stream Dock and Ulanzi: a profile with each legacy action and a Camera Controls car key shows the badge top-right and still works; the PI shows the banner naming the right replacement; turning the setting off removes every badge at once and leaves the banner; switching a Camera Controls key off a moved Mode clears its badge and banner; a Camera Controls dial on Cycle by Car # shows the badge on the strip and on a knob; a disconnected deprecated key shows both badges.
