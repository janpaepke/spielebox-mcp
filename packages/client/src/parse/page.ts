import * as cheerio from "cheerio";
import { OpacMessageError, TermTooShortError, TooManyResultsError } from "../errors.ts";
import { MESSAGES } from "../opac.ts";

export type Page = cheerio.CheerioAPI;

export function loadPage(html: string): Page {
  return cheerio.load(html);
}

/** Collapses whitespace (incl. &nbsp;) and trims. */
export function clean(text: string): string {
  return text.replace(/[\s ]+/g, " ").trim();
}

export type PageMessage = { kind: "info" | "error"; text: string };

/** The info (`#messagebox`) or error (`#errorbox`) box of a page, if any. */
export function readMessage($: Page): PageMessage | null {
  const info = $("#messagebox p").first();
  if (info.length) return { kind: "info", text: clean(info.text()) };
  const error = $("#errorbox p").first();
  if (error.length) return { kind: "error", text: clean(error.text()) };
  return null;
}

/**
 * Interprets the message box of a search response.
 * Returns true for "no results" and throws for every other message; returns false when there is none.
 */
export function checkSearchMessage($: Page, term: string): boolean {
  const message = readMessage($);
  if (!message) return false;
  if (message.text.includes(MESSAGES.noResults)) return true;
  if (message.text.includes(MESSAGES.termTooShort)) throw new TermTooShortError(term);
  if (message.text.includes(MESSAGES.tooManyResults)) throw new TooManyResultsError(term);
  throw new OpacMessageError(message.text);
}
