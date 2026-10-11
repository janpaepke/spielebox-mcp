import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Building blocks for small pages served to the user's own browser: a server on 127.0.0.1 (random port) that only
 * answers requests carrying its exact Host (DNS rebinding), strict security headers, and a shared page layout.
 */

export type LocalHandler = (req: IncomingMessage, res: ServerResponse, origin: string) => Promise<void>;
export type LocalServer = { server: Server; origin: string };

const MAX_BODY = 16 * 1024;

/** Starts a server on 127.0.0.1 that doesn't keep the process alive. */
export function startLocalServer(handler: LocalHandler): Promise<LocalServer> {
  return new Promise((resolve, reject) => {
    let origin = "";
    const server = createServer((req, res) => {
      if (req.headers.host !== new URL(origin).host) {
        send(res, 421, page("Fehler", "<p>Unerwarteter Host.</p>"));
        return;
      }
      handler(req, res, origin).catch(() => send(res, 500, page("Fehler", "<p>Etwas ist schiefgelaufen.</p>")));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      server.unref();
      resolve({ server, origin });
    });
  });
}

export function closeLocalServer(started: LocalServer | null | undefined): Promise<void> {
  return new Promise((resolve) => (started ? started.server.close(() => resolve()) : resolve()));
}

/** Sends a page. Scripts are blocked unless they carry `scriptNonce`. */
export function send(
  res: ServerResponse,
  status: number,
  html: string,
  { scriptNonce }: { scriptNonce?: string } = {},
) {
  const script = scriptNonce ? `script-src 'nonce-${scriptNonce}'; ` : "";
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; ${script}style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The shared page layout (German, light and dark). `body` must already be escaped. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} – Spielebox</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.4rem}ul{padding-left:1.2rem}label{display:block;margin:.6rem 0 .2rem}input[type=text],input[type=email]{width:100%;padding:.4rem;box-sizing:border-box}
.consent{display:flex;gap:.5rem;align-items:flex-start;margin:1rem 0;padding:.8rem;background:#fff;border:1px solid #ccc;border-radius:6px}
.consent input{margin-top:.3rem}.note{color:#555;font-size:.9rem}.error{color:#a00;white-space:pre-wrap}
button{font:inherit;padding:.5rem 1rem;margin:.5rem .5rem 0 0;cursor:pointer}button.primary{background:#1a5;color:#fff;border:0;border-radius:4px}
button.small{padding:.15rem .6rem;margin:0 0 0 .5rem;font-size:.85rem}
.contact{display:grid;grid-template-columns:auto 1fr auto;gap:.3rem .6rem;align-items:center;margin:.5rem 0}
.steps{list-style:none;padding:0}.steps li::before{content:"○ ";color:#999}.steps li.done::before{content:"✓ ";color:#1a5}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#eee}.consent{background:#262626;border-color:#444}.note{color:#aaa}}
</style></head><body>${body}</body></html>`;
}
