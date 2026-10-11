import { MarkupChangedError } from "../errors.ts";

/**
 * Parsers for the catalog's formatted field values. All formats were checked against ~3900 titles (2026-10-11);
 * anything else throws MarkupChangedError instead of guessing.
 */

const AGE = /^ab (\d+) Jahren$/;
const DURATION_BUCKET = /^bis zu (\d+) Minuten$/;
const DURATION_RANGE = /^(\d+) bis (\d+) Minuten$/;
const PLAYERS = /^(\d+) bis (\d+)(?: SpielerInnen)?$/;
const YEAR = /^\d{4}$/;

function match(pattern: RegExp, value: string, field: string): RegExpExecArray {
  const m = pattern.exec(value.trim());
  if (!m) throw new MarkupChangedError(`${field} "${value}"`);
  return m;
}

const int = (s: string | undefined) => Number.parseInt(s ?? "", 10);

/** "ab 10 Jahren" → 10 */
export function parseAgeFrom(value: string): number {
  return int(match(AGE, value, "age")[1]);
}

/** "bis zu 90 Minuten" → 90 */
export function parseDurationBucket(value: string): number {
  return int(match(DURATION_BUCKET, value, "duration")[1]);
}

/** "60 bis 90 Minuten" → { min: 60, max: 90 } */
export function parseDurationRange(value: string): { min: number; max: number } {
  const m = match(DURATION_RANGE, value, "duration");
  return { min: int(m[1]), max: int(m[2]) };
}

/** "3 bis 4" or "3 bis 4 SpielerInnen" → { min: 3, max: 4 } */
export function parsePlayers(value: string): { min: number; max: number } {
  const m = match(PLAYERS, value, "players");
  return { min: int(m[1]), max: int(m[2]) };
}

/** "2025" → 2025 */
export function parseYear(value: string): number {
  return int(match(YEAR, value, "year")[0]);
}

/** Splits an author list. Lists use " - " (hyphenated names have no spaces), details use " ; ". */
export function splitAuthors(value: string): string[] {
  return value
    .split(/\s+[-;]\s+|\s*;\s*/)
    .map((a) => a.trim())
    .filter(Boolean);
}

const ELLIPSIS = /\.\.\.$/;

/** "a, b, Sp..." → { items: ["a", "b"], truncated: true } (the cut-off item is dropped). */
export function splitKeywords(value: string): { items: string[]; truncated: boolean } {
  const truncated = ELLIPSIS.test(value.trim());
  const items = value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (truncated) items.pop();
  return { items, truncated };
}

/** "Lorem ipsum..." → { text: "Lorem ipsum…", truncated: true } */
export function trimDescription(value: string): { text: string; truncated: boolean } {
  const text = value.trim();
  return ELLIPSIS.test(text) ? { text: text.replace(ELLIPSIS, "…"), truncated: true } : { text, truncated: false };
}
