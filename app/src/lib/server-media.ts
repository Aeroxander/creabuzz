/**
 * The app's one cache of pictures kept on this community's server, wired to the reader's signer. The server hands a picture
 * over only to a signed read, which a plain `<img src>` cannot make, so these pictures are fetched here and shown from a
 * local address (`@creaton/core/client/server-media.ts` has the cache and the token source).
 *
 * Signing never makes an account: a read is signed only when somebody is already signed in on this phone, and never while
 * the passkey is locked; anyone else sees the picture's stand-in. Sign-out and switching community reload the page, so one
 * cache per page load never mixes readers or servers.
 */
import {
  existingUserPubkey,
  signAsUser,
} from "@creaton/core/client/identity.ts";
import {
  getUserSigningBlockedReason,
  hasNip07Provider,
} from "@creaton/core/client/nostr-signer.ts";
import { serverMediaUrl } from "@creaton/core/client/media-url.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import {
  createMediaTokenSource,
  createServerMediaCache,
  type MediaFailure,
  type MediaSignerState,
  type ServerMediaCache,
} from "@creaton/core/client/server-media.ts";
import { timedFetchStreamed } from "@creaton/core/client/timed-fetch.ts";
import { useLayoutEffect, useMemo, useState } from "react";

function signerState(): MediaSignerState {
  if (getUserSigningBlockedReason()) return { blocked: "locked" };
  const pubkey = existingUserPubkey();
  if (pubkey) return { key: pubkey };
  if (hasNip07Provider()) return { key: "extension" };
  return { blocked: "signed-out" };
}

let cache: ServerMediaCache | null = null;

function serverMediaCache(): ServerMediaCache {
  cache ??= createServerMediaCache({
    tokens: createMediaTokenSource({ sign: signAsUser, signerState }),
    // A picture whose server never answers, or stalls part way through, ends like any other failed read instead of
    // loading forever: the 30 s deadline covers the picture's bytes as well as the headers.
    fetch: (url, init) =>
      timedFetchStreamed(url, { ...init, timeoutMs: 30_000 }),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });
  return cache;
}

export type PictureSrc =
  | { status: "ready"; src: string }
  | { status: "loading" }
  | { status: "failed"; reason: MediaFailure }
  | { status: "none" };

/**
 * What an `<img>` should load for `url`: a picture on this server is fetched with a signed read and shown from a local
 * address; any other address is not loaded at all (a post never makes the phone ask another website for a picture).
 * `defer` holds the fetch back (until the picture's place nears the screen).
 */
export function usePictureSrc(
  url: string | null,
  options: { defer?: boolean } = {},
): PictureSrc {
  const defer = options.defer ?? false;
  const serverUrl = useMemo(() => {
    if (!url) return null;
    try {
      return serverMediaUrl(url, relayHttpBaseUrl());
    } catch {
      return null;
    }
  }, [url]);
  const [result, setResult] = useState<{
    for: string;
    value: PictureSrc;
  } | null>(null);
  // Layout effect: a picture already in the cache is handed over before the first paint, with no flash of the wait.
  useLayoutEffect(() => {
    if (!serverUrl || defer) return;
    // The cache drops a result whose watch was stopped, so a slow fetch for an earlier address cannot land after this one.
    return serverMediaCache().watch(serverUrl, (value) =>
      setResult({ for: serverUrl, value }),
    );
  }, [serverUrl, defer]);
  if (!url || !serverUrl) return { status: "none" };
  if (result?.for !== serverUrl) return { status: "loading" };
  return result.value;
}
