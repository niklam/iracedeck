import {
  PROFILE_AUTO_SWITCH_ENABLED_KEY,
  PROFILE_FOR_SESSION_KIND_KEYS,
  PROFILE_SWITCH_SESSION_KIND_LABELS,
  PROFILE_SWITCH_SESSION_KINDS,
} from "@iracedeck/app-constants";
import { GlobalSettingsSchema } from "@iracedeck/settings";
import ejs from "ejs";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/global-profile-auto-switch.ejs` (#1111), the
 * settings window's "Automatically switch to profile" card.
 *
 * Its setting keys and row labels are literals, because an `.ejs` file cannot
 * import; they are declared once in `@iracedeck/app-constants`
 * (`profile-auto-switch.ts`), which the settings schema and the plugin's
 * reactor read. A drift is silent — a select bound to a key the schema does
 * not know saves a value nothing reads — so the markup is pinned to the
 * constants and the schema here.
 *
 * It renders a fixture of profiles; the committed `data/profiles.json` is
 * rendered through it beside the data, and the settings window's Profiles pane
 * is held beside the page, in `iracing-actions`' `src/pi-templates/` (#1375).
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const templatePath = path.join(partialsDir, "global-profile-auto-switch.ejs");

type ProfileRow = { name: string; deviceType?: number; displayName?: string };

/** Device variants of two templates: the shape `data/profiles.json` has, small enough to read. */
const fixture: ProfileRow[] = [
  { name: "iRaceDeck Default XL", deviceType: 2, displayName: "iRaceDeck Default" },
  { name: "iRaceDeck Default SD", deviceType: 0, displayName: "iRaceDeck Default" },
  { name: "iRaceDeck Replay XL", deviceType: 2, displayName: "iRaceDeck Replay" },
  { name: "iRaceDeck Replay Plus XL", deviceType: 13, displayName: "iRaceDeck Replay" },
];

function render(profiles: ProfileRow[] = fixture): string {
  const require = (spec: string): unknown => {
    if (spec !== "./data/profiles.json") throw new Error(`unexpected require: ${spec}`);

    return profiles;
  };

  return ejs.render(readFileSync(templatePath, "utf-8"), { require }, { filename: templatePath });
}

/** Each session-kind row: its label, the select's opening tag, and its options as [value, text]. */
function rows(html: string): { label: string; select: string; options: [string, string][] }[] {
  return [
    ...html.matchAll(/<sdpi-item label="([^"]+)">\s*(<sdpi-select[^>]*>)([\s\S]*?)<\/sdpi-select>\s*<\/sdpi-item>/g),
  ].map((m) => ({
    label: m[1]!,
    select: m[2]!,
    options: [...m[3]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((o) => [o[1]!, o[2]!]),
  }));
}

describe("global-profile-auto-switch.ejs (#1111)", () => {
  const html = render();
  const kindRows = rows(html);

  it('binds a global checkbox to the auto-switch toggle, with no default (off; default="false" would render checked)', () => {
    const checkbox = /<sdpi-checkbox[^>]*>/.exec(html)?.[0] ?? "";

    expect(checkbox).toContain(`setting="${PROFILE_AUTO_SWITCH_ENABLED_KEY}"`);
    expect(checkbox).toMatch(/\sglobal[\s>]/);
    expect(checkbox).not.toContain("default=");
    expect(GlobalSettingsSchema.parse({})[PROFILE_AUTO_SWITCH_ENABLED_KEY]).toBe(false);
  });

  it("lists one row per session kind, in the declared order, with the declared labels and keys", () => {
    expect(kindRows.map((r) => r.label)).toEqual(
      PROFILE_SWITCH_SESSION_KINDS.map((k) => PROFILE_SWITCH_SESSION_KIND_LABELS[k]),
    );
    expect(kindRows.map((r) => /setting="([^"]+)"/.exec(r.select)?.[1])).toEqual(
      PROFILE_SWITCH_SESSION_KINDS.map((k) => PROFILE_FOR_SESSION_KIND_KEYS[k]),
    );
  });

  it("binds every row to a global setting the schema defaults to the empty value", () => {
    const defaults = GlobalSettingsSchema.parse({}) as Record<string, unknown>;

    for (const kind of PROFILE_SWITCH_SESSION_KINDS) {
      expect(defaults[PROFILE_FOR_SESSION_KIND_KEYS[kind]], kind).toBe("");
    }

    for (const row of kindRows) {
      expect(row.select, row.label).toMatch(/\sglobal[\s>]/);
      expect(row.select, row.label).toContain('default=""');
    }
  });

  it("collapses device variants of one template into one option", () => {
    const options = rows(
      render([
        { name: "iRaceDeck Race XL", deviceType: 2, displayName: "iRaceDeck Race" },
        { name: "iRaceDeck Race SD", deviceType: 0, displayName: "iRaceDeck Race" },
        { name: "iRaceDeck Test SD", deviceType: 0, displayName: "iRaceDeck Test" },
      ]),
    )[0]!.options;

    expect(options).toEqual([
      ["", "Do not change the profile"],
      ["iRaceDeck Race", "Race"],
      ["iRaceDeck Test", "Test"],
    ]);
  });

  it("explains when it switches, that nothing switches until a row is picked, and why only bundled profiles", () => {
    const text = html.replace(/\s+/g, " ");

    expect(text).toContain("switches every connected Stream Deck to the profile you pick below for the session type");
    expect(text).toContain("switches it back to the profile it was on when iRacing closes");
    expect(text).toContain("Nothing switches until you pick a profile for at least one session type.");
    expect(text).toContain("the Stream Deck app doesn't let a plugin switch to profiles you made yourself");
    expect(text).toContain("edit it in the Stream Deck app");
  });

  it("keeps the rows enabled while the toggle is off — no disabled attribute, no gating script", () => {
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("<script");
  });
});
