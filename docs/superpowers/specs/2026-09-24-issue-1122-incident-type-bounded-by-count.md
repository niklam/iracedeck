# Issue #1122 — The count delta bounds the incident type

> **Issue:** [#1122](https://github.com/niklam/iracedeck/issues/1122) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The Race Engineer announced heavy car contact (4x) for an incident the sim scored 1x. `diff/incidents.ts` types a burst from the `PlayerIncidents` report byte and speaks `incidentTypeValue(type)` (#938); the count delta is only the trigger. A single-slot latch holds the last classified byte for 1.5 s and hands it to the next untyped increment, and worst-severity-wins then refuses the real, lighter byte. So a car-contact byte that scored nothing, followed within 1.5 s by an off-track, speaks as a 4x.

## What the captures add

Re-reading every `local/telemetry-watch-*.jsonl` capture (`20260811-125031-041`, `20260831-215824-076`):

- **An off-track byte leads its count increment by ~185–200 ms** (three occurrences), not ~2 frames. With a single-slot latch, any byte landing in that gap — a 0x contact report — overwrites the off-track type before the increment consumes it. The real type is then gone, not merely outranked.
- **Sequence extent.** Sequence B escalated off-track (+1) to car collision (+3) **4.0 s** later, within one sequence. Two independent off-tracks each moved the count **15.5 s** apart, so a sequence ends somewhere in between.
- Collision-world (`0x05`) reported twice, 50 ms apart, then +2 — duplicate bytes happen.

## Decision

### 1. The count bounds the type — for every byte source

A classified type may type a burst only if

```text
0 < V(type, discipline) <= sequenceTotal
```

where `sequenceTotal` is the sum of count deltas of the current **incident chain**: increments chained while each lands within `INCIDENT_SEQUENCE_GAP_MS` (**10 000 ms**) of the previous one. The chain spans burst boundaries, so sequence B's +3 escalation 4.0 s after its announced +1 has a total of 4 and still announces 4x.

The rule applies to the byte seen on the same tick as the increment, the latched history, and the late-byte retype alike (Niklas, 2026-09-24): the count is the one signal that cannot misreport what the sim scored, and one rule everywhere also covers the alternative the issue could not rule out — the sim itself reporting a collision byte for a 1x increment.

Consequences:

- A 0x byte (`contact-car`, `contact-world`) can never type a burst whose count moved. **So the Contact (wall) and Contact (car) callouts go silent** — before, they fired only when a contact byte was paired with an increment it could not have caused, which is this issue's misattribution. Accepted by Niklas (2026-09-24); whether to remove them or redesign them as byte-only announcements is a follow-up issue, not this one.
- A stale `collision-car` byte cannot type a fresh +1 (total 1 < 4), so the trailing or preceding off-track byte types it instead.
- Worst-severity-wins stays, now among consistent types only.

**Why 10 s.** The gap must exceed the observed in-sequence 4.0 s and lie below the observed separate-sequence 15.5 s. Erring long only loosens the bound — a stale 4x slips through only after a prior chain of 3+ points within 10 s — while erring short silences a genuine late escalation, the worse failure. The capture that would refine it: a deliberate off-track followed by car contact at increasing delays (6, 8, 10, 12 s), recording where the count stops moving by the marginal upgrade and starts moving by the full value.

### 2. The latch becomes a short history

`pendingIncidentType` / `pendingIncidentTypeAt` become a list of `{ type, at }` for every classified byte within `PENDING_INCIDENT_STALENESS_MS` (1500 ms, unchanged). An increment takes the **worst consistent** entry, ties going to the latest (the sequence's score is its worst outcome's value, so the same rule as the burst's worst-severity-wins; amended after review — the first draft said latest, which could type a +2 wall hit as the off-track byte that followed it); any increment clears the history, as the single latch was cleared. The off-track-then-contact ordering therefore resolves to off-track.

### 3. No count-derived type

If no consistent byte is ever seen, the burst stays untyped and flushes silently — #938's accepted "missed byte" degradation, unchanged. Deriving a type from the total was considered and rejected: only a total of 1 maps to a unique type, and the history in §2 already recovers the case that motivated it.

### 4. Debug logging

`diffIncidents` takes the translator's `ILogger` (default `silentLogger`) and logs at debug: each classified byte (report value, count), each increment (delta, chain total, chosen type, and every rejected type with its value), each late-byte retype or rejection, and each flush (type, points, delta). A field report like #1122 can then be matched against the log instead of reconstructed.

### 5. `incident.scored` — the type-blind signal (added after review)

`incident.occurred` fires only for a typed burst, yet two consumers read it as "an incident was scored" and never look at the type: the qualifying lap-invalidation contract and the plugins' `lastIncidentAt` overtake gate. The bound multiplies untyped bursts (a counted incident whose only bytes contradict the count), and #938 already left them silent — so a qualifying contact that moved the count would not invalidate the lap aloud.

A new bus event, `incident.scored { delta }`, fires for **every** counted burst at flush, typed or not, and both type-blind consumers move onto it; `incident.occurred` keeps its contract (every fire has a type) and stays the incident callouts' trigger. On the flush tick the translator emits `incident.scored` **before** `incident.occurred`: the qualifying contract won the Voice bus over the incident contracts by registration order on one shared event, and with two events publication order is what keeps that. Rejected: a nullable `type` on `incident.occurred` (breaks its documented contract for every consumer) and accepting the gap.

## Out of scope

- The `incident.occurred` payload, clip wording — what is announced for a consistent sequence is unchanged.
- Burst cadence (`INCIDENT_BURST_QUIET_MS`, `INCIDENT_BURST_MAX_MS`, `INCIDENT_LATE_TYPE_MS`).
- The penalty byte stays unused (#938).
- Opponent incidents.

## Testing

Unit tests in `packages/sim-events-iracing/src/diff/incidents.test.ts`:

- **The reported bug:** `collision-car` byte with no count movement, then +1 with a null byte, then an `off-track` byte 30 ms later → one `off-track`, points 1.
- **Preceding order:** `off-track` byte, then a `contact-car` / `collision-car` byte, then +1 → `off-track`, points 1.
- **Contact then quiet:** a `contact-car` byte with no increment → nothing emitted, and a +1 three seconds later (untyped) stays silent.
- **Same-tick contradiction:** `collision-car` on the same tick as a fresh +1 → not typed by it.
- **Genuine escalation still announces 4x:** the capture's sequence B replayed (off-track +1, flush, `collision-car` +3 at +4.0 s) → points 1 then points 4; a fresh `collision-car` +4 → points 4; dirt `collision-car` +2 → points 2.
- **Chain expiry:** an escalation +3 arriving more than 10 s after the chain's last increment is not typed as `collision-car`.
- Every existing #938 capture replay stays green.

Manual: in a practice session with debug logging on, go off track shortly after light car contact and confirm the engineer calls an off-track, and the log shows the rejected contact type.
