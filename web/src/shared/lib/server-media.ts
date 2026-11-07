/**
 * Pictures on the community server's own media path, loaded with a signed read.
 *
 * The server answers every `GET /media/<sha256>` only with an
 * `Authorization: Nostr <base64 event>` header carrying a kind:24242 `t=get`
 * event (BUD-01), then checks the reader may use this server. A plain
 * `<img src>` cannot send that header, so these pictures are fetched here and
 * shown from an object URL.
 *
 * One server-scoped token (a `server` tag, no `x` tag) admits every picture on
 * that host until it expires, and the server keeps no replay record for reads,
 * so it is reused across pictures. Its lifetime is the strict window the server
 * may enforce (60 s from `created_at`), which the lenient window also accepts.
 *
 * Kept free of app imports so the node unit tests drive the real code; the
 * app's wiring (signer, server address, `fetch`, object URLs) is in
 * `server-media-loader.ts`.
 */

/** The event the token source asks the signer to sign. */
type MediaTokenTemplate = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

/** Why a picture on this server cannot be shown to this reader right now. */
export type MediaFailure =
  /** Nobody is signed in in this browser, so there is nobody to sign the read. */
  | "signed-out"
  /** The passkey is not unlocked this session. */
  | "locked"
  /** Signing the read failed (for example a signer extension said no). */
  | "refused"
  /** The server did not hand the picture over, or it is not a picture. */
  | "unavailable";

export class MediaUnavailableError extends Error {
  readonly reason: Exclude<MediaFailure, "unavailable">;
  /** What the signer threw, when it was asked and failed. */
  readonly signerError?: unknown;
  constructor(
    reason: Exclude<MediaFailure, "unavailable">,
    signerError?: unknown,
  ) {
    super(`picture read not signed (${reason})`);
    this.name = "MediaUnavailableError";
    this.reason = reason;
    this.signerError = signerError;
  }
}

class MediaLoadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MediaLoadError";
    this.status = status;
  }
}

/** Who would sign a read now: a key that changes with the identity, or why nobody can. */
export type MediaSignerState =
  | { key: string }
  | { blocked: "signed-out" | "locked" };

export interface MediaTokenSourceOptions {
  sign(template: MediaTokenTemplate): Promise<unknown>;
  signerState(): MediaSignerState;
  nowMs?(): number;
  /** Seconds from `created_at` to `expiration`. The server's strict window is 60. */
  lifetimeSeconds?: number;
  /** A token this close to expiring is not handed out again. */
  renewBeforeSeconds?: number;
  /** After a signing failure, how long to stop asking the same signer again. */
  refusalCooldownMs?: number;
}

export interface MediaTokenSource {
  /** The `Authorization` header value for reads on `host`. */
  header(host: string): Promise<string>;
  /** Forget `header` (the server refused it), so the next read signs a fresh one. */
  drop(header: string): void;
}

/**
 * `created_at` is set this far back so a browser clock a few seconds ahead of
 * the server's still passes its "not from the future" check (5 s of skew).
 */
const CLOCK_SKEW_SECONDS = 5;

/**
 * One token at a time, reused until shortly before it expires; one signing at
 * a time (concurrent callers share it); a token signed for an identity that is
 * no longer current is never stored.
 */
export function createMediaTokenSource(
  options: MediaTokenSourceOptions,
): MediaTokenSource {
  const nowMs = options.nowMs ?? (() => Date.now());
  const lifetime = options.lifetimeSeconds ?? 60;
  const renewBefore = options.renewBeforeSeconds ?? 15;
  const cooldown = options.refusalCooldownMs ?? 30_000;

  let slot: { key: string; header: string; expiresAtMs: number } | null = null;
  let inflight: { key: string; promise: Promise<string> } | null = null;
  let refused: { key: string; untilMs: number } | null = null;

  return {
    header(host) {
      const state = options.signerState();
      if ("blocked" in state) {
        return Promise.reject(new MediaUnavailableError(state.blocked));
      }
      const key = `${state.key}\n${host}`;
      const now = nowMs();
      if (
        slot &&
        slot.key === key &&
        now < slot.expiresAtMs - renewBefore * 1000
      ) {
        return Promise.resolve(slot.header);
      }
      if (refused && refused.key === key && now < refused.untilMs) {
        return Promise.reject(new MediaUnavailableError("refused"));
      }
      if (inflight && inflight.key === key) return inflight.promise;

      const createdAt = Math.floor(now / 1000) - CLOCK_SKEW_SECONDS;
      const expiresAt = createdAt + lifetime;
      const entry = { key } as { key: string; promise: Promise<string> };
      // Registered before signing starts, so a signer that fails at once still
      // finds itself current and clears the slot behind it.
      inflight = entry;
      entry.promise = (async () => {
        try {
          const signed = await options.sign({
            kind: 24242,
            created_at: createdAt,
            tags: [
              ["t", "get"],
              ["expiration", String(expiresAt)],
              ["server", host],
            ],
            content: "Show pictures from this server",
          });
          const header = `Nostr ${btoa(JSON.stringify(signed))}`;
          // Fence: a signing that finished after the identity changed (a new
          // signing replaced this one) must not become the current token.
          if (inflight === entry) {
            slot = { key, header, expiresAtMs: expiresAt * 1000 };
          }
          return header;
        } catch (error) {
          if (inflight === entry) {
            refused = { key, untilMs: nowMs() + cooldown };
          }
          throw new MediaUnavailableError("refused", error);
        } finally {
          if (inflight === entry) inflight = null;
        }
      })();
      return entry.promise;
    },
    drop(header) {
      if (slot?.header === header) slot = null;
    },
  };
}

/** What a watcher of one picture is told, once. */
type MediaResult =
  | { status: "ready"; src: string }
  | { status: "failed"; reason: MediaFailure };

export interface ServerMediaCacheOptions {
  tokens: MediaTokenSource;
  fetch(url: string, init: RequestInit): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  nowMs?(): number;
  /** Pictures kept after nothing shows them any more (count). */
  maxEntries?: number;
  /** Pictures kept after nothing shows them any more (total bytes). */
  maxBytes?: number;
  /** A single picture larger than this is not held in memory. */
  maxPictureBytes?: number;
  /** How long a picture the server would not hand over is not asked for again. */
  failureMemoMs?: number;
}

export interface ServerMediaCache {
  /**
   * Load `url` (a `serverMediaUrl` result) and tell `listener` once, unless the
   * returned stop function ran first: a result for a picture nobody is waiting
   * on any more is dropped, never delivered late. While watched, the picture's
   * object URL is never revoked.
   */
  watch(url: string, listener: (result: MediaResult) => void): () => void;
}

type Entry = { objectUrl: string; bytes: number };

export function createServerMediaCache(
  options: ServerMediaCacheOptions,
): ServerMediaCache {
  const nowMs = options.nowMs ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? 64;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxPictureBytes = options.maxPictureBytes ?? 20 * 1024 * 1024;
  const failureMemoMs = options.failureMemoMs ?? 30_000;

  /** Loaded pictures, least recently used first (Map keeps insertion order). */
  const entries = new Map<string, Entry>();
  let totalBytes = 0;
  /** How many watchers each picture has; a watched picture is never evicted. */
  const refs = new Map<string, number>();
  const inflight = new Map<string, Promise<string>>();
  const failures = new Map<string, { untilMs: number; error: unknown }>();

  function evict() {
    if (entries.size <= maxEntries && totalBytes <= maxBytes) return;
    for (const [url, entry] of entries) {
      if (entries.size <= maxEntries && totalBytes <= maxBytes) return;
      if (refs.has(url)) continue;
      entries.delete(url);
      totalBytes -= entry.bytes;
      options.revokeObjectURL(entry.objectUrl);
    }
  }

  function rememberFailure(url: string, error: unknown) {
    failures.delete(url);
    failures.set(url, { untilMs: nowMs() + failureMemoMs, error });
    while (failures.size > maxEntries) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  }

  async function read(url: string, host: string): Promise<Response> {
    const header = await options.tokens.header(host);
    const response = await options.fetch(url, {
      headers: { Authorization: header },
    });
    if (response.status !== 401) return response;
    // The server refused the token (clock skew, or it expired in flight): sign
    // a fresh one and try once more — never more than that.
    options.tokens.drop(header);
    const fresh = await options.tokens.header(host);
    return options.fetch(url, { headers: { Authorization: fresh } });
  }

  /** A picture the server would not hand over: remembered for a while, then thrown. */
  function failed(url: string, message: string, status?: number) {
    const failure = new MediaLoadError(message, status);
    rememberFailure(url, failure);
    return failure;
  }

  async function fetchPicture(url: string): Promise<string> {
    const host = new URL(url).host;
    let response: Response;
    try {
      response = await read(url, host);
    } catch (error) {
      if (error instanceof MediaUnavailableError) throw error;
      throw failed(url, "picture request failed");
    }
    const { status } = response;
    if (!response.ok) throw failed(url, `picture refused (${status})`, status);
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw failed(url, "not a picture", status);
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxPictureBytes) {
      throw failed(url, "picture too large", status);
    }
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      throw failed(url, "picture download failed", status);
    }
    if (blob.size > maxPictureBytes) {
      throw failed(url, "picture too large", status);
    }
    const objectUrl = options.createObjectURL(blob);
    entries.set(url, { objectUrl, bytes: blob.size });
    totalBytes += blob.size;
    evict();
    return objectUrl;
  }

  function load(url: string): Promise<string> {
    const failure = failures.get(url);
    if (failure) {
      if (nowMs() < failure.untilMs) return Promise.reject(failure.error);
      failures.delete(url);
    }
    const pending = inflight.get(url);
    if (pending) return pending;
    const promise = fetchPicture(url).finally(() => inflight.delete(url));
    inflight.set(url, promise);
    return promise;
  }

  function failureOf(error: unknown): MediaFailure {
    return error instanceof MediaUnavailableError
      ? error.reason
      : "unavailable";
  }

  return {
    watch(url, listener) {
      let active = true;
      refs.set(url, (refs.get(url) ?? 0) + 1);
      const entry = entries.get(url);
      if (entry) {
        // Most recently used: move to the end.
        entries.delete(url);
        entries.set(url, entry);
        listener({ status: "ready", src: entry.objectUrl });
      } else {
        load(url).then(
          (src) => {
            if (active) listener({ status: "ready", src });
          },
          (error: unknown) => {
            if (active)
              listener({ status: "failed", reason: failureOf(error) });
          },
        );
      }
      return () => {
        if (!active) return;
        active = false;
        const left = (refs.get(url) ?? 1) - 1;
        if (left > 0) refs.set(url, left);
        else refs.delete(url);
        evict();
      };
    },
  };
}
