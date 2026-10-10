import { describe, expect, it } from "vitest";
import { isMediaId, toMediaId } from "./ids.ts";

describe("toMediaId", () => {
  // Pairs observed on the live OPAC and in a reservation e-mail (2026-10-10).
  it.each([
    [59721, "7f346bb939125766393fd9addfa10a93"], // ZAUBERBERG
    [28882, "48c1c1cfe38d8291bb6b2f09319c58df"], // GALAXY TRUCKER
    [60081, "3375ddafbc45fed35c0da0b4cc481084"], // CATAN Connect
  ])("maps %i to %s", (titleNo, mediaId) => {
    expect(toMediaId(titleNo)).toBe(mediaId);
  });

  it.each([-1, 1.5, Number.NaN])("rejects %s", (titleNo) => {
    expect(() => toMediaId(titleNo)).toThrow(RangeError);
  });
});

describe("isMediaId", () => {
  it("accepts 32-char lowercase hex", () => expect(isMediaId("7f346bb939125766393fd9addfa10a93")).toBe(true));
  it("rejects other strings", () => expect(isMediaId("59721")).toBe(false));
});
