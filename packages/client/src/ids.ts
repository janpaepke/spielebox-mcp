import { createHash } from "node:crypto";

/** Media ids are 32-char lowercase hex: the md5 of the catalog's integer title number (TitelNr). */
export const MEDIA_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Derives the OPAC media id from a title number, e.g. `59721` → `7f346bb9…`. */
export function toMediaId(titleNo: number): string {
  if (!Number.isSafeInteger(titleNo) || titleNo < 0) {
    throw new RangeError(`Invalid title number: ${titleNo}`);
  }
  return createHash("md5").update(String(titleNo)).digest("hex");
}

export function isMediaId(value: string): boolean {
  return MEDIA_ID_PATTERN.test(value);
}
