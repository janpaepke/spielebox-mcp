import { spawn } from "node:child_process";

/** Opens a URL in the user's default browser. Best effort: failures are ignored, the caller also returns the link. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["explorer.exe", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available (e.g. headless); the link is still in the tool result.
  }
}
