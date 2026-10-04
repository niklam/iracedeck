# Lazy template context

> **Issue:** [#1339](https://github.com/niklam/iracedeck/issues/1339) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`buildTemplateContextFromData` materialises the whole `{{…}}` variable space on every build: six driver namespaces, `session`, `track`, a flatten of every telemetry variable, and a flatten of the entire session-info YAML. The flatten of every driver and every session's results is the largest item. `SDKController.getCurrentTemplateContext()` caches the result for one telemetry frame only, so any templated key keeps it rebuilding. After #1337 stopped Chat multiplying it per key, it was still the largest single item in a 35-car profile (~4% of samples, with YAML parsing at another ~1%), while a template typically reads two or three variables.

## Decision

### 1. The context becomes a lookup, not two prebuilt maps

`TemplateContext` changes from `{ display: Record<string, string>; raw: Record<string, unknown> }` to an object answering one path at a time:

```typescript
interface TemplateContext {
  display(path: string): string | undefined;           // what {{path}} renders
  raw(path: string): { found: boolean; value?: unknown }; // what an expression reads
}
```

Nothing enumerates the maps today. The only readers are `resolveTemplate` (`context.display[path]`) and `resolveExpression` (`Object.hasOwn(vars, path)` then `vars[path]`), so the change is confined to those two call sites, their tests, and the code that builds a context. `found` keeps the evaluator's present-but-undefined versus absent distinction, which `Object.hasOwn` gives today.

A Proxy over the old maps was rejected: it would keep the shape while hiding the laziness behind traps (`get`, `has`, `getOwnPropertyDescriptor`) that every future reader would have to know about.

### 2. Namespaces are built on first use, per context

The first path segment selects a namespace: `self`, `track_ahead`, `track_behind`, `race_ahead`, `race_behind`, `focused`, `session`, `track`, `telemetry`, `sessionInfo`.

- A context instance builds a namespace the first time a path in it is asked for, and keeps it for the rest of that instance's life. One frame's context therefore costs only the namespaces its templates touch.
- The inputs shared by several namespaces, namely the driver list, the player's car index, the race order and the iRating estimate, are computed once per instance, and only when the first driver namespace needs them.

### 3. `telemetry.*` and `sessionInfo.*` resolve by walking the source object

There is no flatten. The lookup walks the source object for that one path and formats the leaf with the **same** per-leaf rule `flattenContext` applies today: booleans as `Yes`/`No`, the `BOOLEAN_INT_FIELDS` set, integers as integers, other numbers to two decimals, strings as-is, and arrays and objects absent from `display`. That rule is extracted into one function used by both, so the two paths cannot drift. `telemetry.CarIdx*` stays excluded, as today.

### 4. Session-info-derived parts survive across frames

The SDK already tracks when iRacing publishes new session info: `IRacingSDK.getSessionInfo()` returns the same parsed object until `SessionInfoUpdate` changes, and a new one after. The `track` namespace and the driver list are therefore memoised on the identity of that object, which is the session-info version without a new API, and which also covers a context built from plain data (tests, the press-time builds). A frame-to-frame rebuild with unchanged session info reuses them. `sessionInfo.*` needs no memo, because a path walk costs no more than a lookup. The telemetry-derived namespaces (`self` and the neighbours, `session`'s clock fields) are recomputed per context instance as today, because their inputs change every frame.

### 5. Telemetry Display and templated titles resolve inside their throttle

Measured 2026-10-04 with #1337 applied (35-car AI race, sampling allocation profile): the plugin allocated about 92 MB/s, and two thirds of it was `buildTemplateContextFromData`. It was reached from Telemetry Display's telemetry subscription, which resolves the key's template on every tick before handing the image to its `imageThrottle`. One templated Telemetry Display key therefore rebuilds the shared context every frame. The subscription now schedules the whole update, template resolution included, through the throttle, so a templated key asks for a context at most ten times a second. This is the same shape #1337 gave Chat. Laziness (2–4) makes each build cheap; this makes them rare.

User-entered key titles with a template (`BaseAction`'s title-template subscription, #899) had the same shape: each tick re-resolved every tracked title, and only a changed result went to `titleTemplateThrottle`. They move inside the throttle too, so after this change no display path asks for a context on every frame. A value change can now wait for the throttle's trailing edge, up to 100 ms, where it used to render on the frame it changed. That is accepted for a display capped at ten updates a second.

### 6. Output is identical

For any path the old builder produced, the new context returns the same `display` string and the same `raw` value. A path the old builder did not produce is absent (`display` undefined, `raw` not found). This is a pure performance change, with no new variables and no renamed ones.

## Out of scope

- New template variables, syntax or formatting changes.
- The #1337 throttle and the per-frame cache invalidation, which stay as they are.
- Chat's and Race Admin's press-time builds. They now get the cheap context for free and need no change of their own.

## Testing

- **Equivalence.** Keep the current builder as a test-only reference. For a set of fixtures (a race with an injected order, practice, qualifying pre-green, a spectator with the camera on another car, disconnected with session info only, and nothing at all), every key in the reference's `display` and `raw` maps must resolve to an identical value through the new context. Also check a sample of absent paths, including `telemetry.CarIdxPosition` and prototype names such as `constructor` and `__proto__`.
- **Laziness.** A context asked only for `self.position` builds no other namespace and never walks `sessionInfo`. Spy on the namespace builders.
- **Telemetry Display throttle.** A burst of ticks inside one window asks for at most a leading and a trailing context. A disappearing key drops its pending update.
- **Memoisation.** Two frames with the same session-info version build the `track` namespace and the driver list once. A version change rebuilds them.
- **Resolver and evaluator.** The existing `template-resolver` and `expression-evaluator` suites pass unchanged in what they assert, with their fixtures adapted to the lookup interface.
- **Manual.** The #1337 measurement: the same 6 templated Chat keys in a 35-car race, profiled over the debug port. Template building should drop out of the top of the profile, and every key should render the same text as before.
