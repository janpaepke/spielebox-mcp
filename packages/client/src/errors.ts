/** Base class for all errors thrown by the client. `code` is stable and safe to branch on. */
export class SpieleboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The OPAC rejects search terms shorter than 3 characters. */
export class TermTooShortError extends SpieleboxError {
  constructor(term: string) {
    super("TERM_TOO_SHORT", `Search term must be at least 3 characters long: "${term}"`);
  }
}

/** The OPAC refuses searches with more than 1400 hits, even when facets would narrow them down. */
export class TooManyResultsError extends SpieleboxError {
  constructor(term: string) {
    super("TOO_MANY_RESULTS", `Search for "${term}" matches more than 1400 games; use a more specific term`);
  }
}

/** The OPAC answered with a message the client doesn't know. */
export class OpacMessageError extends SpieleboxError {
  readonly opacMessage: string;

  constructor(opacMessage: string) {
    super("OPAC_MESSAGE", `The catalog responded: ${opacMessage}`);
    this.opacMessage = opacMessage;
  }
}

/** The HTML no longer has the expected structure; the parsers need updating. */
export class MarkupChangedError extends SpieleboxError {
  constructor(what: string, options?: ErrorOptions) {
    super("MARKUP_CHANGED", `Unexpected catalog markup: ${what}`, options);
  }
}

/** A non-2xx HTTP response or a network failure after retries. */
export class HttpError extends SpieleboxError {
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super("HTTP", message, options);
    this.status = status;
  }
}
