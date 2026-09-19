import { invokeTauri } from "@/shared/api/tauri";

import { parsePaperclipStatus, type PaperclipStatus } from "./paperclipStatus";

export async function fetchPaperclipStatus(): Promise<PaperclipStatus> {
  return parsePaperclipStatus(await invokeTauri<unknown>("paperclip_status"));
}

export async function startPaperclip(): Promise<PaperclipStatus> {
  return parsePaperclipStatus(await invokeTauri<unknown>("start_paperclip"));
}

export async function stopPaperclip(): Promise<PaperclipStatus> {
  return parsePaperclipStatus(await invokeTauri<unknown>("stop_paperclip"));
}

/**
 * Open Paperclip's own UI in a native window.
 *
 * A window rather than a frame: the app's CSP has no `frame-src`, so a frame
 * falls back to `default-src 'self'` and is refused in a packaged build. The
 * window also carries the NIP-07 signer that logs the page in with the user's
 * Buzz identity.
 */
export type WebviewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Open Paperclip's UI, docked over `bounds` by default.
 *
 * Docking parents the window to the app window and drops its decorations, so it
 * sits over the content area and moves with the app. The window is still a real
 * webview, which is why Paperclip's page runs first-party and the injected NIP-07
 * signer works - an iframe would get neither.
 */
export async function openPaperclipWindow(
  url: string,
  options: { docked?: boolean; bounds?: WebviewRect } = {},
): Promise<void> {
  await invokeTauri<void>("open_paperclip_window", {
    url,
    docked: options.docked ?? true,
    bounds: options.bounds ?? null,
  });
}

export async function setPaperclipWindowBounds(
  bounds: WebviewRect,
): Promise<void> {
  await invokeTauri<void>("set_paperclip_window_bounds", { bounds });
}

export async function closePaperclipWindow(): Promise<void> {
  await invokeTauri<void>("close_paperclip_window");
}
