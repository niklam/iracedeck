/// <reference lib="dom" />
/**
 * List of the installed Race Engineer voice packs (issue #1034), now also
 * showing where each one came from and offering a way to remove it (#1100).
 *
 * Renders the `_voicePacks` plugin-global — `{ packs, problems }`, the whole
 * result of the last scan, republished by the plugin after every one — so the
 * settings window shows what is actually loaded AND why anything else was
 * ignored. A hand-placed pack that does nothing used to be merely absent here,
 * with the reason only in the plugin log; it now says what is wrong with it.
 *
 * A pack can appear in both halves: one that loads but declares a voice with no
 * clips under it is installed and still reports a problem.
 *
 * It still writes nothing back to the setting it renders — `_voicePacks` is an
 * observation about the run, not a setting, and stays run-scoped in `deck-core`
 * (`RUN_SCOPED_SETTING_KEYS`) so it is never persisted. Only a RESCAN (fired by
 * the sibling `ird-voice-pack-refresh` button) changes what this list shows;
 * this component only ever reflects the next `_voicePacks` push. The one
 * addition since #1034 is that a row's Remove button sends a COMMAND
 * (`voicePackRemove`) rather than writing a setting — the removal itself
 * happens in the plugin, and the row disappears only once the next scan says
 * so, the same as it would for a pack deleted by hand and rescanned.
 *
 * ROW LAYOUT (#1145). Each pack is three lines: its label with the version and
 * provenance as a right-aligned pair of pills, then the voices it provides,
 * then the Remove button or the note that stands in its place. The voices line
 * is what tells apart packs that share a label, and the action gets a line of
 * its own because the armed Remove is too wide to share one.
 *
 * PROVENANCE BADGE. Each row now names where its pack came from: downloaded
 * from iRaceDeck's own catalog, put there by iRaceDeck itself, installed by
 * hand, or — on a repo developer's build only (#1143) — found in the
 * development voice root. Since #1034 stage 3 the plugin ships no audio, so
 * nothing is "built in" any more and the second of those reads "Installed by
 * iRaceDeck" — the `bundled-seed` provenance behind it is a record written on
 * disk, which an installation carried over from a bundling release can still
 * be holding. This is deliberately INFORMATION, not a verdict — see the `provenance` field
 * doc on `InstalledVoicePack` in deck-core's `voice-pack-scanner.ts`: "the
 * badge tells a user that a pack came from someone other than us; it is not a
 * trust decision the plugin acts on." A user's own sideloaded pack is a
 * perfectly ordinary thing to have, so the wording says where a pack came
 * from and stops there — it never calls a sideloaded pack unsigned,
 * unverified, or anything else that reads as a warning about the user's own
 * choice. A missing or unrecognised provenance value renders as "Installed by
 * hand" (the least-trusting label) rather than dropping the row: id / label /
 * version / voices are required for a row to render AT ALL because together
 * they ARE the row, but provenance is one presentational field on top of an
 * otherwise-valid pack, and a scanner hiccup on that one field must not hide a
 * voice the user can actually play.
 *
 * THE DEVELOPMENT BUILD (#1143) is the row a release build can never show. A
 * plugin built with development mode on — a worktree's `dev.local.json`, or
 * the machine-wide `IRACEDECK_DEV_VOICES=1` (#1214) — scans a development
 * voice root FIRST, so a pack found there is the one actually playing in the
 * sim — and the row says so, naming the directory in place of a Remove button.
 * Both halves earn their place: the badge is what tells a developer who forgot
 * the mode is on why editing the catalog copy changes nothing they hear, and
 * the directory is what tells two clones of the repo apart. There is no Remove
 * because the plugin never deletes from a directory it did not create; that
 * folder is the packer's staged output inside somebody's checkout, and the way
 * to stop using it is `pnpm dev:voices off`, not a button here.
 *
 * THE MANAGED PACK (#1034 stage 3) is another row with no Remove: iRaceDeck
 * installs the pack it keeps current and refreshes it at launch, so removing it
 * would only be undone at the next start, and the row says so in place of the
 * button. Which pack that is comes from the plugin, as a `managed` flag on the
 * row it publishes — this list never infers it from an id or a provenance. So
 * the badge and the flag stay independent (a hand-placed folder sitting at the
 * managed id is still the pack the plugin refreshes, and says "Installed by
 * hand" while offering no Remove), and a later change of which pack iRaceDeck
 * keeps current needs no edit here. An older plugin's payload carries no flag
 * at all, which reads as "not managed" and leaves every row as it was.
 *
 * REMOVE is a two-step: the first press arms the button, which relabels itself
 * "Remove — are you sure?", and a second press sends `voicePackRemove`.
 *
 * A speed bump rather than a ceremony, because the asymmetry is real but
 * modest: removing costs a re-download of a pack that is reproducible from the
 * catalog, not user data that cannot be recovered. It is inline rather than a
 * modal for two reasons — a modal here means `window.confirm`, and this feature
 * deliberately owns no dialog-shaped code at all; and an inline two-step is a
 * state-driven button, which is the shape `ird-enable-feature` already
 * establishes and which the rules require these buttons to follow.
 *
 * What cancels an armed Remove is spelled out at {@link armRemove}, including
 * what deliberately does not.
 *
 * Usage:
 * ```html
 * <ird-voice-pack-list></ird-voice-pack-list>
 * <ird-voice-pack-list packs="_voicePacks"></ird-voice-pack-list>
 * ```
 */
import { sendToPlugin } from "./sdpi-client.js";
import { skipUnchanged } from "./settings-change-filter.js";

let styleInjected = false;

const DEFAULT_PACKS_SETTING = "_voicePacks";

/**
 * Mirrors `VoicePackProvenanceKind` in deck-core's `voice-pack-scanner.ts`.
 * Kept as a local literal union rather than an import — this package's
 * components deliberately re-declare the shapes they render instead of
 * depending on deck-core's Node-oriented package at runtime (see
 * `key-binding-input.ts` and `binding-status.ts` for the same call).
 *
 * Four values since #1143. `development` is unlike the other three: it is never
 * written to a pack's record on disk, but assigned from the ROOT the plugin
 * found the pack in — so no folder can claim it, and a release build, which
 * scans no such root, can never publish it.
 */
const KNOWN_PROVENANCE = ["catalog", "bundled-seed", "sideload", "development"] as const;
type VoicePackProvenance = (typeof KNOWN_PROVENANCE)[number];

/**
 * Badge text per provenance — matches the wording on the website's voices doc.
 *
 * `bundled-seed` no longer says "Built-in" (#1034 stage 3): the plugin ships no
 * audio, so nothing is built into it. The VALUE survives, because it is a record
 * on disk that an installation upgraded from a bundling release keeps until its
 * pack is next refreshed, and the label has to stay true of what that record now
 * means — iRaceDeck put the pack there.
 *
 * `development` (#1143) names the mechanism rather than an origin, because that
 * is the fact a developer needs: this build is reading a root a release build
 * does not have, and what is playing is a checkout rather than an install.
 */
const PROVENANCE_LABELS: Record<VoicePackProvenance, string> = {
  catalog: "Downloaded",
  "bundled-seed": "Installed by iRaceDeck",
  sideload: "Installed by hand",
  development: "Development build",
};

/**
 * Anything other than a recognised value falls back to `sideload` — the
 * label that implies the least about a pack's origin — rather than being
 * treated as a reason to drop the whole row. See the module comment.
 */
function normalizeProvenance(value: unknown): VoicePackProvenance {
  return typeof value === "string" && (KNOWN_PROVENANCE as readonly string[]).includes(value)
    ? (value as VoicePackProvenance)
    : "sideload";
}

/**
 * The plugin's view of deck-core's `InstalledVoice`: a voice is an id AND a
 * name (#1034). The parsed callout script the full type also carries is the
 * engine's input, never published on `_voicePacks` (#1064) — so this row
 * type is deliberately the two fields the list renders and nothing more.
 */
type VoicePackVoice = { id: string; label: string };
type VoicePackEntry = {
  id: string;
  label: string;
  version: string;
  voices: VoicePackVoice[];
  provenance: VoicePackProvenance;
  /**
   * The plugin's statement that THIS is the pack iRaceDeck keeps current
   * (#1034 stage 3) — the one row that offers no Remove.
   *
   * Optional and read as `=== true`, never as a truthy test: an older plugin
   * publishes no such field, and a payload that says nothing about a pack must
   * leave it as removable as it was.
   */
  managed?: boolean;
  /**
   * The directory the pack was found in, rendered on a development row (#1143)
   * and on no other.
   *
   * Optional, and its absence costs the row nothing but the path: it is one
   * presentational field on an otherwise-valid pack, the same call the
   * `provenance` fallback makes. A row that says it is a development build with
   * no directory to show still says the useful half.
   */
  dir?: string;
};
type VoicePackProblemEntry = { pack: string; reason: string };
type VoicePackScan = { packs: VoicePackEntry[]; problems: VoicePackProblemEntry[] };

const EMPTY_SCAN: VoicePackScan = { packs: [], problems: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Accept only entries with the fields we render, and coerce nothing: a
 * malformed entry is dropped rather than displayed as `undefined`.
 */
function parseScan(raw: string): VoicePackScan {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) return EMPTY_SCAN;

    const packs = Array.isArray(parsed.packs) ? parsed.packs : [];
    const problems = Array.isArray(parsed.problems) ? parsed.problems : [];

    return {
      packs: packs
        .filter((entry): entry is Record<string, unknown> & { voices: unknown[] } => {
          if (!isRecord(entry)) return false;

          return (
            typeof entry.id === "string" &&
            typeof entry.label === "string" &&
            typeof entry.version === "string" &&
            Array.isArray(entry.voices) &&
            // Checked rather than trusted: the payload is the plugin's, but the
            // LABELS inside it come from a third party's manifest, and this array
            // is what a multi-voice pack row will render from.
            entry.voices.every((v) => isRecord(v) && typeof v.id === "string" && typeof v.label === "string")
          );
        })
        // `provenance` is normalized rather than checked in the filter above:
        // a missing/unrecognised value must not drop an otherwise-valid row
        // (see the module comment), so it is defaulted here instead. `managed`
        // is narrowed the same way and for the same reason — an older plugin's
        // payload omits it, and anything but a literal `true` means "not the
        // pack iRaceDeck keeps current", so it can never withhold a Remove by
        // accident. `dir` is spread in only when it is a string, so anything
        // else leaves the field absent rather than rendering as a path.
        .map((entry): VoicePackEntry => ({
          id: entry.id as string,
          label: entry.label as string,
          version: entry.version as string,
          voices: entry.voices as VoicePackVoice[],
          provenance: normalizeProvenance(entry.provenance),
          managed: entry.managed === true,
          ...(typeof entry.dir === "string" ? { dir: entry.dir } : {}),
        })),
      problems: problems.filter((entry): entry is VoicePackProblemEntry => {
        if (!isRecord(entry)) return false;

        return typeof entry.pack === "string" && typeof entry.reason === "string";
      }),
    };
  } catch {
    return EMPTY_SCAN;
  }
}

/**
 * How long a Remove stays armed before it disarms itself.
 *
 * The hazard a confirmation is meant to remove is an accidental press; a
 * confirmation that stays armed forever reintroduces it in a worse form,
 * because the second press is the destructive one and a user who walked away
 * comes back to a button whose label they no longer read. Eight seconds is long
 * enough to read four words and move a mouse without hurrying, and too short to
 * survive a phone call.
 */
export const VOICE_PACK_REMOVE_ARM_MS = 8000;

/** The Remove button's two labels. */
const RESTING_REMOVE_LABEL = "Remove";
const ARMED_REMOVE_LABEL = "Remove — are you sure?";

export class VoicePackList extends HTMLElement {
  private list: HTMLDivElement | null = null;
  private _initialized = false;
  /**
   * The pack id whose Remove is armed, or null.
   *
   * ONE id rather than a flag per row, which is what makes "arming another
   * pack's Remove cancels the first" fall out of the state shape instead of
   * needing its own handler. Held on the element rather than in the DOM so a
   * re-render — a rescan landing mid-confirmation — does not silently disarm.
   */
  private armed: string | null = null;
  private armedTimer: number | null = null;
  /**
   * The armed pack's identity when it was armed — see {@link identityOf} for
   * what that covers.
   *
   * Presence of the id alone is not enough. The pack at a given id is the
   * FOLDER at that name, and its manifest can be edited in place: same id, new
   * version, new label. The armed state would then carry over onto a row the
   * user is reading as a different pack, and their next press — which they
   * would take for a first press — removes it.
   *
   * The 8-second clock already makes that very hard to reach, since changing a
   * manifest means leaving the window for Explorer. This is defence in depth
   * behind it, and it makes the guard actually do what its comment claims.
   */
  private armedIdentity: string | null = null;
  /**
   * The armed button element, so arming and disarming MUTATE it rather than
   * re-rendering the list.
   *
   * Re-rendering to show an armed state destroyed the very button that took the
   * press, dropping focus to the body — which left the two-step with no
   * keyboard route at all: Enter armed a button the user was no longer on, and
   * the clock disarmed it before they could tab back. That is the same
   * focus-loss this component's push filter was added to prevent, in the one
   * rebuild the filter cannot cover because it is deliberate.
   */
  private armedButton: HTMLButtonElement | null = null;

  disconnectedCallback(): void {
    this.clearArmedState();
  }

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.buildDOM();
    this.hookSettings();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-voice-pack-list { display: block; }
      ird-voice-pack-list .ird-vp-row {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 6px 0;
        color: #d8d8d8;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-voice-pack-list .ird-vp-row + .ird-vp-row { border-top: 1px solid #3d3d3d; }
      /* Line one (#1145). Wraps as a whole: when label and pills do not fit side
         by side, the pills drop beneath and margin-left:auto keeps them on the
         right edge, so every row's badge still lines up. min-width:0 plus
         overflow-wrap:anywhere let a label with no spaces break instead of
         overflowing the card. */
      ird-voice-pack-list .ird-vp-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 3px 8px;
      }
      ird-voice-pack-list .ird-vp-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: #ffffff; }
      ird-voice-pack-list .ird-vp-pills { flex: none; display: flex; gap: 4px; margin-left: auto; }
      /* Version and provenance are one visual family (#1145): two facts about the
         same pack, not a number floating beside a badge. */
      ird-voice-pack-list .ird-vp-pill {
        padding: 1px 6px;
        border: 1px solid transparent;
        border-radius: 3px;
        font-size: 7.5pt;
        letter-spacing: 0.2px;
        white-space: nowrap;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      /* An outline, not a fill: a grey fill all but vanished into the card
         (#262626) and read as one blob beside the grey bundled-seed badge. */
      ird-voice-pack-list .ird-vp-version { border-color: #555555; color: #b4b4b4; }
      /* Fixed width, text centred: the pills are right-aligned, so without it
         only the badges' RIGHT edges line up and "Downloaded" starts further
         right than "Installed by hand". Sized to the longest label, "Installed
         by iRaceDeck"; a longer one would only widen its own badge. */
      ird-voice-pack-list .ird-vp-badge { min-width: 12em; text-align: center; }
      ird-voice-pack-list .ird-vp-voices { color: #b4b4b4; font-size: 8pt; overflow-wrap: anywhere; }
      ird-voice-pack-list .ird-vp-action { display: flex; align-items: center; min-width: 0; }
      ird-voice-pack-list .ird-vp-empty { color: #969696; font-size: 9pt; padding: 3px 0; }
      /* Stands on line three (#1145) where a Remove button would be on a row
         that offers none — the pack iRaceDeck manages (#1034 stage 3), a
         bundled seed (#1100), or a development build showing its directory
         (#1143), which wraps anywhere rather than overflowing the card.
         Muted and unclickable-looking on purpose: a statement, not a control. */
      ird-voice-pack-list .ird-vp-note { color: #969696; font-size: 8pt; overflow-wrap: anywhere; min-width: 0; }
      /* Provenance badge (#1100) — informational, not a warning: colours stay
         calm and distinct rather than using red/amber alarm colours anywhere. */
      ird-voice-pack-list .ird-vp-badge-catalog { background: #1f3a52; color: #8ec9ff; }
      ird-voice-pack-list .ird-vp-badge-bundled-seed { background: #34343a; color: #c8c8c8; }
      ird-voice-pack-list .ird-vp-badge-sideload { background: #3a331f; color: #e0c07a; }
      /* #1143 — a fourth calm colour, cool and clearly not one of the other
         three, so a development row reads as distinct without reading as an
         alarm. It only ever appears on a developer's own build. */
      ird-voice-pack-list .ird-vp-badge-development { background: #24303d; color: #a9d6ff; }
      ird-voice-pack-list .ird-vp-remove-button {
        flex: none;
        padding: 2px 8px;
        font-size: 8pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
        color: #c9c9c9;
        background: transparent;
        border: 1px solid #555;
        border-radius: 3px;
        cursor: pointer;
      }
      ird-voice-pack-list .ird-vp-remove-button:hover {
        color: #ffffff;
        border-color: #e05a5a;
        background: #3a2426;
      }
      ird-voice-pack-list .ird-vp-remove-button-armed,
      ird-voice-pack-list .ird-vp-remove-button-armed:hover {
        color: #ffffff;
        border-color: #e05a5a;
        background: #6d2a2e;
      }
      ird-voice-pack-list .ird-vp-problem {
        display: block;
        padding: 3px 0;
        color: #ffe9b8;
        font-size: 8pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-voice-pack-list .ird-vp-row + .ird-vp-problem,
      ird-voice-pack-list .ird-vp-problem + .ird-vp-problem { border-top: 1px solid #3d3d3d; }
      ird-voice-pack-list .ird-vp-problem-pack { color: #ffffff; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.list = document.createElement("div");
    this.appendChild(this.list);
    this.render(EMPTY_SCAN);
  }

  /**
   * Arm `id`, replacing whatever was armed before, and start the disarm clock.
   *
   * What cancels, decided explicitly rather than left to whatever the DOM
   * happens to do:
   *
   * - **The clock.** {@link VOICE_PACK_REMOVE_ARM_MS} later it disarms itself.
   *   This is the one that matters, because it is the only cancel that fires
   *   when the user is not there.
   * - **Arming another pack's Remove**, which follows from `armed` being a
   *   single id rather than a flag per row.
   * - **A successful removal**, since `render` drops an armed pack the scan no
   *   longer lists — or one whose id is still there under a different version,
   *   label, badge or set of voices, which is a folder edited in place rather
   *   than the pack the arm was given to.
   *
   * What deliberately does NOT cancel: blur, and a click elsewhere on the page.
   * The settings window is one long scrolling page a user clicks around in —
   * scrolling the card, checking a callout, moving to another tab and back —
   * and cancelling on any of that would make the confirmation feel like it had
   * lost the press rather than protected it. The clock covers the case an
   * outside-click handler is really reaching for.
   */
  private armRemove(pack: VoicePackEntry, button: HTMLButtonElement): void {
    this.clearArmedState();
    this.armed = pack.id;
    this.armedIdentity = VoicePackList.identityOf(pack);
    this.armedButton = button;
    VoicePackList.dressButton(button, true);
    this.armedTimer = window.setTimeout(() => {
      this.armedTimer = null;
      this.clearArmedState();
    }, VOICE_PACK_REMOVE_ARM_MS);
  }

  /**
   * Put a Remove button into its armed or resting appearance.
   *
   * `aria-pressed` because the label change is the only signal a sighted user
   * gets, and without it the state change is announced to nothing.
   */
  private static dressButton(button: HTMLButtonElement, armed: boolean): void {
    button.textContent = armed ? ARMED_REMOVE_LABEL : RESTING_REMOVE_LABEL;
    button.classList.toggle("ird-vp-remove-button-armed", armed);
    button.setAttribute("aria-pressed", armed ? "true" : "false");
  }

  /**
   * What makes an armed pack the SAME pack on a later scan.
   *
   * Id plus every pack-derived cell a row displays: label, version, the
   * provenance badge and the voice labels (#1145). A folder replaced at the same id keeps the id and changes
   * some of these, and a row the user reads as different must not inherit an
   * arm they gave to what was there before — including the case where only the
   * badge flips, a catalog copy swapped for a hand-placed one.
   *
   * `managed` joins them for the same reason (#1034 stage 3): it decides
   * whether the row ends in a button or a note, which is as visible a change as
   * any of the cells. Without it an arm given to a removable row could survive a
   * scan that turned the pack managed and back, and the returning button would
   * render pre-confirmed.
   *
   * The voices' labels join them since #1145, when the row began naming the
   * voices a pack provides; the rule is what the user can SEE change, and for
   * packs sharing a label that line is the one cell that tells them apart. Their
   * ids stay out, because no row renders an id. `dir` (#1143) is excluded for a
   * different reason: it is rendered, but only on a development row, which
   * offers no Remove and so can never hold an arm — and `provenance`, which is
   * what makes a row that kind of row, is already here.
   */
  private static identityOf(pack: VoicePackEntry): string {
    return JSON.stringify([
      pack.id,
      pack.version,
      pack.label,
      pack.provenance,
      pack.managed === true,
      pack.voices.map((voice) => voice.label),
    ]);
  }

  /**
   * Forget the armed pack, stop its clock, and put its button back to rest.
   *
   * Restores the button IN PLACE rather than re-rendering, which is what lets
   * every disarm path share one implementation — the clock, the confirming
   * press, a scan that dropped the pack, and disconnection.
   *
   * The confirming press matters most here. It used to clear the state and
   * deliberately skip a redraw, reasoning that the removal would land a new
   * scan — which it does not when the removal FAILS: the installer writes a
   * warning banner and republishes nothing, and the plugin dedupes the pack
   * list at source, so no push ever corrected the label. The button sat red and
   * reading "are you sure?" indefinitely with no armed state behind it, and the
   * next press silently spent the confirmation it appeared to be offering.
   */
  private clearArmedState(): void {
    this.clearArmedTimer();
    this.armed = null;
    this.armedIdentity = null;

    const button = this.armedButton;

    this.armedButton = null;

    if (button !== null) VoicePackList.dressButton(button, false);
  }

  private clearArmedTimer(): void {
    if (this.armedTimer !== null) window.clearTimeout(this.armedTimer);

    this.armedTimer = null;
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const packsKey = this.getAttribute("packs") ?? DEFAULT_PACKS_SETTING;

    window.SDPIComponents.useGlobalSettings(
      packsKey,
      skipUnchanged((value: string) => {
        // Repeat pushes are filtered by `skipUnchanged`, not here. This
        // component had its own guard first, being where the unkeyed
        // subscription was noticed; it now shares the one every settings-bound
        // component uses, so there is a single answer rather than a special
        // case. It matters here because a rebuild replaces the armed button,
        // and a click landing across one is swallowed.
        this.render(value ? parseScan(value) : EMPTY_SCAN);
      }),
    );
  }

  /**
   * Line one (#1145): the pack's label, then its version and provenance as a
   * right-aligned pair of pills, version first. The line wraps as a whole when a
   * long label leaves no room, and the pills keep their right edge on the line
   * they wrap to, so every row's badge still lines up.
   */
  private static headLine(entry: VoicePackEntry): HTMLDivElement {
    const head = document.createElement("div");
    head.className = "ird-vp-head";

    const label = document.createElement("span");
    label.className = "ird-vp-label";
    label.textContent = entry.label;

    const pills = document.createElement("span");
    pills.className = "ird-vp-pills";

    const version = document.createElement("span");
    version.className = "ird-vp-pill ird-vp-version";
    version.textContent = entry.version;

    const badge = document.createElement("span");
    badge.className = `ird-vp-pill ird-vp-badge ird-vp-badge-${entry.provenance}`;
    badge.textContent = PROVENANCE_LABELS[entry.provenance];

    pills.append(version, badge);
    head.append(label, pills);

    return head;
  }

  /**
   * Line two (#1145): the voices the pack provides, by the labels the dropdown
   * puts after the pack prefix. It is what tells apart two packs that share a
   * label — the dropdown already names them `<pack>: <voice>`, and without this
   * line the list offered no way to see which row a dropdown entry belongs to.
   *
   * Always shown, even for `Voice: Default` under a pack called Default: a line
   * that appears only sometimes would make its absence a question. A pack with no
   * voices gets no line — the scanner lists none since #1144, and the one branch
   * that could (a bundled seed) is kept only for robustness.
   */
  private static voicesLine(entry: VoicePackEntry): HTMLDivElement | null {
    if (entry.voices.length === 0) return null;

    const line = document.createElement("div");
    const names = entry.voices.map((voice) => voice.label).join(", ");

    line.className = "ird-vp-voices";
    line.textContent = `${entry.voices.length === 1 ? "Voice" : "Voices"}: ${names}`;

    return line;
  }

  private static note(text: string): HTMLSpanElement {
    const note = document.createElement("span");

    note.className = "ird-vp-note";
    note.textContent = text;

    return note;
  }

  /**
   * Line three (#1145): what the user can do with the pack, or why they cannot.
   * Its own line because the armed "Remove — are you sure?" is wide enough to
   * push the voices into a wrap on a shared one.
   */
  private actionFor(entry: VoicePackEntry): HTMLElement {
    // A pack from the development voice root (#1143): what is playing is a
    // checkout, not an install, and the row names the directory in place of a
    // button. No Remove, because the plugin never deletes from a directory it
    // did not create.
    //
    // FIRST, ahead of both rules below. A development row is decided by WHERE
    // the plugin found the pack — the plugin also clears `managed` for it, so
    // the two should never both be true, but the page's own rule stands on its
    // own feet rather than on that: whatever else a row claims, iRaceDeck does
    // not keep a folder in somebody's checkout current, and the note has to
    // name the directory that is actually playing.
    if (entry.provenance === "development") {
      const note = VoicePackList.note(entry.dir ?? "From the development voice root");

      // The path wraps on its own line rather than overflowing the card, but a
      // wrapped path is still hard to read, so it is repeated as a title — the
      // one place a full path is always readable on one line.
      if (entry.dir !== undefined) note.title = entry.dir;

      return note;
    }

    // The pack iRaceDeck manages (#1034 stage 3): the launch step installs
    // and refreshes it, so a Remove would only be undone at the next start.
    // The row says so in place of the button. Keyed by the plugin-published
    // flag, never by provenance — the flag is the plugin's statement.
    //
    // Ahead of the bundled-seed rule below: this is the case with a
    // live reason, and the two would otherwise both be true of one row on an
    // installation upgraded from a bundling release, whose note would then
    // say the audio ships with the plugin when it no longer does.
    if (entry.managed === true) return VoicePackList.note("Kept up to date by iRaceDeck");

    // A pack the PLUGIN provides gets no Remove, and what stands in its
    // place is a STATEMENT rather than a disabled button (#1100).
    //
    // The condition is deliberately "bundled seed AND provides nothing", not
    // provenance alone. `voices` is empty exactly while the plugin's own
    // audio owns every voice this pack declares — so the row is describing
    // something the user cannot meaningfully delete: removing the folder
    // changes nothing they can hear, because the bundle keeps playing the
    // voice.
    //
    // That condition is also what retires the branch, and #1034 stage 3 is
    // the release that does it: with nothing bundled the scanner reserves no
    // voice ids, so it emits no such row and the case stops arising by
    // itself, rather than leaving a working, user-owned pack permanently
    // unremovable and mislabelled. Since #1144 the scanner cannot emit one
    // at all: it drops no voice to the bundle, and lists no pack without a
    // voice. Kept rather than deleted because it describes a ROW, not a
    // release: a row that provides nothing earns a statement instead of a
    // button whenever one turns up, and that is decided by the plugin, not
    // here.
    //
    // NOT because it would be undone on the next start — that reason is
    // false often enough to be worth naming, and it belongs to the managed
    // branch above rather than to this one. `VoicePackInstaller.seed()`
    // skips with `packs-present` whenever any pack directory exists, and its
    // own comment calls removing the seeded copy a choice the plugin must not
    // argue with. So with a second pack installed a removal WOULD stick. The
    // button is withheld because its effect would be invisible, not because
    // it would be reverted.
    //
    // A DISABLED button would be worse than none: it still invites the click
    // and still has to explain itself, where a line of text simply answers
    // the question a missing button raises.
    if (entry.provenance === "bundled-seed" && entry.voices.length === 0) {
      return VoicePackList.note("Included with the plugin");
    }

    // Two-step, in the state-driven shape `ird-enable-feature` establishes:
    // the button renders the CURRENT state rather than firing and hoping. A
    // first press arms it, a second removes. See `armRemove` for what cancels.
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ird-vp-remove-button";
    VoicePackList.dressButton(remove, false);

    // A genuine scan change can rebuild the list while a confirmation is
    // open, so the armed pack's NEW button has to be dressed and adopted —
    // the old element is gone and clearing state through it would be a no-op.
    if (this.armed === entry.id) {
      this.armedButton = remove;
      VoicePackList.dressButton(remove, true);
    }

    remove.addEventListener("click", () => {
      if (this.armed === entry.id) {
        // Resets the button in place on the way out, so a removal that FAILS
        // leaves it reading "Remove" rather than a red button with no armed
        // state behind it.
        this.clearArmedState();
        sendToPlugin({ event: "voicePackRemove", id: entry.id });

        return;
      }

      this.armRemove(entry, remove);
    });

    return remove;
  }

  /**
   * Rendered with `textContent` per cell rather than innerHTML: a pack's
   * `label` and its voices' labels (#1145) come from its own
   * `voice-pack.json`, and a problem row is built from a
   * folder name and a manifest field — on the sideload path, all of it is a
   * file some third party wrote. `provenance` is the one field NOT taken from
   * that file (see `voice-pack-provenance.ts`: a pack cannot declare its own
   * provenance), so its badge text is one of the four fixed labels above —
   * never rendered from pack-supplied text.
   *
   * A development row's `dir` (#1143) is the one path this list renders, and it
   * comes from the plugin — the root it scanned plus the folder name — rather
   * than from anything the pack wrote. `textContent` all the same: the rule
   * here is per cell, not per field's pedigree.
   */
  private render(scan: VoicePackScan): void {
    if (!this.list) return;

    // A pack that is gone cannot be armed. Without this, a removal that
    // succeeded elsewhere — or a pack deleted by hand — would leave the id
    // armed, and the next pack to take that id would render pre-confirmed.
    if (
      this.armed !== null &&
      !scan.packs.some((pack) => pack.id === this.armed && VoicePackList.identityOf(pack) === this.armedIdentity)
    ) {
      this.clearArmedState();
    }

    this.list.textContent = "";

    // Only when the scan found nothing at all. A directory holding one
    // unloadable pack is not empty, and calling it empty would hide the very
    // row that explains the silence.
    //
    // An ordinary state again since #1034 stage 3. It was a rare one while the
    // plugin seeded a pack out of its own bundle; nothing ships inside the
    // plugin now, and the pack iRaceDeck keeps current is INSTALLED at launch —
    // so a first run that could not reach the catalog (offline, or an
    // unwritable packs folder) genuinely has nothing installed, and should be
    // told exactly that rather than shown a row for audio not on the disk.
    if (scan.packs.length === 0 && scan.problems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ird-vp-empty";
      empty.textContent = "No voice packs installed.";
      this.list.appendChild(empty);

      return;
    }

    for (const entry of scan.packs) {
      const row = document.createElement("div");
      row.className = "ird-vp-row";
      row.appendChild(VoicePackList.headLine(entry));

      const voices = VoicePackList.voicesLine(entry);

      if (voices !== null) row.appendChild(voices);

      const action = document.createElement("div");
      action.className = "ird-vp-action";
      action.appendChild(this.actionFor(entry));
      row.appendChild(action);

      this.list.appendChild(row);
    }

    for (const problem of scan.problems) {
      const row = document.createElement("div");
      row.className = "ird-vp-problem";

      const pack = document.createElement("span");
      pack.className = "ird-vp-problem-pack";
      pack.textContent = problem.pack;

      row.appendChild(pack);
      row.appendChild(document.createTextNode(` — ignored: ${problem.reason}`));
      this.list.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-voice-pack-list")) {
  customElements.define("ird-voice-pack-list", VoicePackList);
}
