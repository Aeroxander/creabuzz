/**
 * Read a room or board once it has been on screen a moment with the page in view (D101), and again when the server
 * counts something new in it while it is open. The same rule the community's workspace applies to the room it shows,
 * for a board opened on its own page.
 */

import { useEffect, useState } from "react";

/** How long a room has to be on screen before it counts as read. */
const READ_AFTER_MS = 1500;

export function useReadWhileOnScreen(
  markRead: (channelId: string) => void,
  /** The room or board on screen, or null when none is. */
  onScreen: string | null,
  /** The server's newest anchor for it: a new one starts the moment again. */
  latest: string | null,
): void {
  // Only while the page is in view: a page that comes back into view starts the moment again.
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const onChange = () =>
      setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  useEffect(() => {
    if (!pageVisible || onScreen === null || latest === null) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") markRead(onScreen);
    }, READ_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [pageVisible, onScreen, latest, markRead]);
}
