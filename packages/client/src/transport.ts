import PQueue from "p-queue";
import { HttpError } from "./errors.ts";
import { DEFAULT_BASE_URL, LOCATION, SESSION_COOKIE, SESSION_IDLE_MS } from "./opac.ts";

export type TransportOptions = {
  baseUrl: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch: typeof fetch;
  userAgent: string;
  /** Minimum spacing between requests to the OPAC. */
  minIntervalMs: number;
  timeoutMs: number;
  /** Retries for failed GETs (network errors, 429, 5xx). */
  retries: number;
  /** Clock, injectable for tests. */
  now: () => number;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * HTTP access to the OPAC: one PHP session (cookie), serialized and spaced requests, timeouts and GET retries.
 *
 * The session is dropped after {@link SESSION_IDLE_MS} of inactivity, before the server would expire it.
 * `generation` changes whenever the session changes, so callers can invalidate state tied to it.
 */
export class Transport {
  readonly #options: TransportOptions;
  readonly #queue: PQueue;
  #cookie: string | null = null;
  #lastRequestAt = 0;
  #generation = 0;

  constructor(options: TransportOptions) {
    this.#options = options;
    this.#queue = new PQueue({ concurrency: 1, interval: options.minIntervalMs, intervalCap: 1 });
  }

  /** Increments whenever the OPAC session is replaced. */
  get generation(): number {
    return this.#generation;
  }

  resetSession(): void {
    this.#cookie = null;
    this.#generation++;
  }

  /** Drops the session if it has been idle long enough that the server may have expired it. */
  dropIdleSession(): void {
    if (this.#cookie && this.#options.now() - this.#lastRequestAt > SESSION_IDLE_MS) this.resetSession();
  }

  /** The catalog URL for the given params (`location` is added). */
  url(params: Record<string, string>): string {
    return `${this.#options.baseUrl}?${new URLSearchParams({ ...params, location: LOCATION })}`;
  }

  /** GET `index.php` with the given params (`location` is added). Returns the HTML. */
  async get(params: Record<string, string>): Promise<string> {
    const url = this.url(params);
    const html = await this.#queue.add(() => this.#getWithRetry(url));
    if (html === undefined) throw new HttpError(`Request aborted: ${url}`);
    return html;
  }

  /**
   * POSTs a form to `index.php?<query>`. **Never retried**: a POST may have taken effect even if the response was lost.
   */
  async post(query: Record<string, string>, form: Record<string, string>): Promise<string> {
    const url = this.url(query);
    const html = await this.#queue.add(async () => {
      let response: Response;
      try {
        response = await this.#options.fetch(url, {
          method: "POST",
          headers: {
            "user-agent": this.#options.userAgent,
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
            cookie: ["lang=de", this.#cookie].filter(Boolean).join("; "),
          },
          body: new URLSearchParams(form).toString(),
          signal: AbortSignal.timeout(this.#options.timeoutMs),
        });
      } catch (error) {
        throw new HttpError(`POST failed, outcome unknown: ${url}`, undefined, { cause: error });
      }
      this.#lastRequestAt = this.#options.now();
      this.#storeSession(response);
      if (!response.ok) throw new HttpError(`HTTP ${response.status} for POST ${url}`, response.status);
      return response.text();
    });
    if (html === undefined) throw new HttpError(`Request aborted: ${url}`);
    return html;
  }

  async #getWithRetry(url: string): Promise<string> {
    this.dropIdleSession();
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#options.fetch(url, {
          headers: {
            "user-agent": this.#options.userAgent,
            cookie: ["lang=de", this.#cookie].filter(Boolean).join("; "),
          },
          signal: AbortSignal.timeout(this.#options.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.#options.retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new HttpError(`Request failed: ${url}`, undefined, { cause: error });
      }
      this.#lastRequestAt = this.#options.now();
      this.#storeSession(response);
      if (response.ok) return response.text();
      if (RETRYABLE.has(response.status) && attempt < this.#options.retries) {
        await sleep(retryAfter(response) ?? backoff(attempt));
        continue;
      }
      throw new HttpError(`HTTP ${response.status} for ${url}`, response.status);
    }
  }

  #storeSession(response: Response): void {
    const session = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!session || session === this.#cookie) return;
    if (this.#cookie) this.#generation++;
    this.#cookie = session;
  }
}

export const defaultTransportOptions = (userAgent: string): TransportOptions => ({
  baseUrl: DEFAULT_BASE_URL,
  fetch: globalThis.fetch.bind(globalThis),
  userAgent,
  minIntervalMs: 500,
  timeoutMs: 30_000,
  retries: 2,
  now: Date.now,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 0.5 s, 1 s, 2 s … plus up to 250 ms jitter. */
const backoff = (attempt: number) => 500 * 2 ** attempt + Math.random() * 250;

/** `Retry-After` in seconds, capped at 10 s. */
function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : null;
}
