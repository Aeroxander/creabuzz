/**
 * Whether this build offers the desktop app (`VITE_DESKTOP_APP=1`). The first release is the web app alone, so by
 * default nothing asks people to download or open the desktop app.
 */
export const DESKTOP_APP =
  (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_DESKTOP_APP === "1";
