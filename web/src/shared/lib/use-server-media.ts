import { useLayoutEffect, useMemo, useState } from "react";

import { serverMediaUrl } from "@/shared/lib/mediaUrl";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import type { MediaFailure } from "@/shared/lib/server-media";
import { serverMediaCache } from "@/shared/lib/server-media-loader";

export type ServerMediaSrc =
  /** Show this address (an object URL for a server picture, else the address itself). */
  | { status: "ready"; src: string }
  /** A server picture still being fetched. */
  | { status: "loading" }
  /** A server picture this reader cannot see now. */
  | { status: "failed"; reason: MediaFailure }
  /** No address. */
  | { status: "none" };

/**
 * What an `<img>` should load for `url`. Pictures on the community server's
 * own media path are fetched with a signed read; every other address is
 * returned unchanged and loads as before. `defer` holds a server picture's
 * fetch back (for example until it scrolls near the screen).
 */
export function useServerMediaSrc(
  url: string | null | undefined,
  options: { defer?: boolean } = {},
): ServerMediaSrc {
  const defer = options.defer ?? false;
  const serverUrl = useMemo(() => {
    if (!url) return null;
    try {
      return serverMediaUrl(url, relayHttpBaseUrl());
    } catch {
      return null;
    }
  }, [url]);
  // The result is stored with the address it is for, so a render after the
  // address changed never shows the previous picture.
  const [result, setResult] = useState<{
    for: string;
    value: ServerMediaSrc;
  } | null>(null);

  // Layout effect: a picture already in the cache is handed over before the
  // first paint, without a flash of the loading state.
  useLayoutEffect(() => {
    if (!serverUrl || defer) return;
    // The cache drops a result whose watch was stopped, so a slow fetch for
    // an earlier address cannot land after this one (Rule 2).
    return serverMediaCache().watch(serverUrl, (value) =>
      setResult({ for: serverUrl, value }),
    );
  }, [serverUrl, defer]);

  if (!url) return { status: "none" };
  if (!serverUrl) return { status: "ready", src: url };
  if (result?.for !== serverUrl) return { status: "loading" };
  return result.value;
}
