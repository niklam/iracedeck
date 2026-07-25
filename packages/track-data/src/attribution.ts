/**
 * Attribution for the bundled corner dataset (issue #888).
 *
 * The data is lovely-track-data by Lovely Sim Racing, CC BY-NC-SA 4.0.
 * Constantinos Demetriadis (LSR) granted iRaceDeck use of the data
 * (2026-07-19) on condition that the feature stays free, Lovely Sim Racing
 * is credited in the plugin UI and docs, and LSR's own Racing Circuits
 * attribution is passed through. Surfacing these credits is a GRANT
 * CONDITION — never remove them from the PI or the website docs.
 */
export const CORNER_DATA_ATTRIBUTION = {
  sourceName: "Lovely Sim Racing",
  copyrightNotice: "© 2025 Lovely Sim Racing",
  sourceUrl: "https://github.com/Lovely-Sim-Racing/lovely-track-data",
  license: "CC BY-NC-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  /** CC BY-NC-SA requires disclosing modifications to the licensed material. */
  changesNotice: "Pruned and normalized corner-marker data.",
  namesCredit: "Racing Circuits",
} as const;
