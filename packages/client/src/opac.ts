import type { Availability, SortOrder } from "./schema.ts";

/** Constants of the WIENXTRA web OPAC ("wienXtra PHP Factory"). See docs/opac-research.md. */

export const DEFAULT_BASE_URL = "https://opac.wienxtra.at/index.php";

/** `location` parameter of the Spielebox catalog. */
export const LOCATION = "sb";

export const SESSION_COOKIE = "wienXtraopac";

/** PHP session lifetime is 24 min idle; renew a bit earlier to avoid racing it. */
export const SESSION_IDLE_MS = 20 * 60_000;

export const PAGE_SIZE = 20;

/** Status icon (`img/status_<color>.gif`) → availability. */
export const STATUS_ICONS: Record<string, Availability> = {
  green: "available",
  blue: "on_site_only",
  red: "borrowed",
  unknown: "unknown",
};

/** `sortorder` values: md5 of the DB column; constant across catalog imports. */
export const SORT_IDS: Record<SortOrder, string> = {
  title: "216316427eb766582cbf41b491a1527e",
  author: "d49c74dae9f2f97e1f4d2a1165e73900",
  year: "e884abab76eeda623d89f8cc133a3b54", // md5("erscheinungsjahr")
  ageFrom: "16c520900fcccd8784dea6595e01cca3", // md5("alter_von")
  classification: "523adec3edf03f229344ab9ae96fc7a2", // md5("systematik")
};

/** Facet box heading → query parameter. */
export const FACET_PARAMS = {
  Standort: "standid",
  Medienart: "medid",
  Erscheinungsjahr: "yearid",
  Alterseignung: "agefromid",
  Spieldauer: "maxdurationid",
  SpielerInnen: "gamerid",
  Schlagworte: "cwid",
} as const;
export type FacetHeading = keyof typeof FACET_PARAMS;

export const ONLINE_RESERVATION_NOTE = "muss online vorbestellt werden";

export const MESSAGES = {
  termTooShort: "mindestens 3 Zeichen",
  tooManyResults: "mehr als 1400 Ergebnisse",
  noResults: "lieferte keine Ergebnisse",
} as const;
