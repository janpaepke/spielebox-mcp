/**
 * Checks GitHub once per process for a newer release and hands out a one-time notice for the user.
 *
 * Distribution concern only: the catalog client knows nothing about it. The check starts lazily (first tool call), never
 * blocks a tool call, and stays silent on any failure (offline, rate limit, unexpected response).
 */
export type UpdateCheckOptions = {
  currentVersion: string;
  /** `owner/name` of the GitHub repository whose latest release is checked. */
  repository: string;
  /** How to install an update, appended to the notice (depends on how the server was distributed). */
  howToUpdate: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class UpdateCheck {
  readonly #options: UpdateCheckOptions;
  #latest: Promise<{ version: string; url: string } | null> | null = null;
  #announced = false;

  constructor(options: UpdateCheckOptions) {
    this.#options = options;
  }

  /** Starts the check in the background (once). */
  start(): void {
    this.#latest ??= this.#fetchLatest().catch(() => null);
  }

  /**
   * The notice, if a newer release is known by now and it hasn't been handed out yet. Doesn't wait for a pending check:
   * the notice then comes with a later call.
   */
  async takeNotice(): Promise<string | null> {
    if (this.#announced || !this.#latest) return null;
    const latest = await Promise.race([this.#latest, Promise.resolve(undefined)]);
    if (!latest || !isNewer(latest.version, this.#options.currentVersion)) return null;
    this.#announced = true;
    return (
      `Update available: spielebox-mcp ${latest.version} (installed: ${this.#options.currentVersion}). ` +
      `${this.#options.howToUpdate} ${latest.url}`
    );
  }

  async #fetchLatest(): Promise<{ version: string; url: string } | null> {
    const { repository, timeoutMs = 5000 } = this.#options;
    const res = await (this.#options.fetch ?? fetch)(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `spielebox-mcp/${this.#options.currentVersion}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") return null;
    return { version: release.tag_name.replace(/^v/, ""), url: release.html_url };
  }
}

/** Compares `x.y.z` versions numerically; anything unparsable counts as not newer. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
