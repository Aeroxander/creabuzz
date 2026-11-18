/**
 * The HTTP client isomorphic-git talks to the server through, with a stall deadline over a whole clone or fetch.
 *
 * isomorphic-git's own browser client (`isomorphic-git/http/web`) sends a plain `fetch` with no signal, so a server
 * that accepts the connection and then never answers (or stalls mid-pack) leaves the repository page loading forever.
 * {@link withGitDeadline} hands the client a signal and watches the waits on the server: when nothing arrives for
 * {@link GIT_STALL_MS} while the operation is waiting on it, every request of that operation is aborted (headers and
 * the pack being streamed), and the operation ends with `ServerTimeoutError`, which the page reads as "the server did
 * not answer". A pack that keeps arriving, however slowly, is never cut off by the stall deadline; only a much larger
 * cap ({@link GIT_CAP_MS}) bounds the whole operation.
 *
 * Pure: no Vite aliases, so the node test runner imports it directly.
 */
import type {
  GitHttpRequest,
  GitHttpResponse,
  HttpClient,
} from "isomorphic-git/http/web";
import {
  ServerTimeoutError,
  withDeadline,
} from "../../../shared/lib/timed-fetch.ts";

/** How long the server may send nothing while a clone or fetch is waiting on it. */
const GIT_STALL_MS = 30_000;
/** The most one clone or fetch may take, start to finish, however steadily the pack arrives. */
const GIT_CAP_MS = 30 * 60_000;

/** Marks the start and end of each wait on the server, so only time spent waiting counts towards a stall. */
interface ServerWaits {
  begin(): void;
  end(): void;
}

const NO_WAITS: ServerWaits = { begin() {}, end() {} };

async function waitedOn<T>(waits: ServerWaits, pending: Promise<T>) {
  waits.begin();
  try {
    return await pending;
  } finally {
    waits.end();
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function collect(
  body: AsyncIterableIterator<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of body) {
    parts.push(part);
    size += part.byteLength;
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

function chunksOf(
  stream: ReadableStream<Uint8Array>,
  waits: ServerWaits,
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  const iterator: AsyncIterableIterator<Uint8Array> = {
    async next() {
      const { done, value } = await waitedOn(waits, reader.read());
      return done
        ? { done: true, value: undefined }
        : { done: false, value: value };
    },
    async return() {
      reader.releaseLock();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

async function* once(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes;
}

/**
 * An isomorphic-git HTTP client whose every request carries `signal`, the reply body included. Same request and reply
 * shape as `isomorphic-git/http/web`. `waits` is told when each wait on the server (headers, a body chunk) starts and
 * ends.
 */
export function gitHttpClient(
  signal: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  waits: ServerWaits = NO_WAITS,
): HttpClient {
  return {
    async request({
      url,
      method = "GET",
      headers = {},
      body,
    }: GitHttpRequest): Promise<GitHttpResponse> {
      // A browser cannot stream an upload, so a request body is sent whole (as isomorphic-git's own client does).
      const sent = body ? await collect(body) : undefined;
      const response = await waitedOn(
        waits,
        fetchImpl(url, {
          method,
          headers,
          body: sent as BodyInit | undefined,
          signal,
        }),
      );
      const replyHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        replyHeaders[key] = value;
      });
      const replyBody = response.body
        ? chunksOf(response.body, waits)
        : once(new Uint8Array(await waitedOn(waits, response.arrayBuffer())));
      return {
        url: response.url || url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        body: replyBody,
        headers: replyHeaders,
      };
    },
  };
}

/**
 * Run one clone or fetch: `operation` gets the HTTP client to pass to isomorphic-git. Ends with `ServerTimeoutError`
 * when the server sends nothing for {@link GIT_STALL_MS} while the operation waits on it, or when the whole operation
 * passes {@link GIT_CAP_MS}; either way every request it started is aborted. Time spent working on what already
 * arrived (indexing the pack) does not count as a stall.
 */
export function withGitDeadline<T>(
  operation: (http: HttpClient) => Promise<T>,
  options: { stallMs?: number; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<T> {
  const stallMs = options.stallMs ?? GIT_STALL_MS;
  return withDeadline(
    (outer) =>
      new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let waiting = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          outer.removeEventListener("abort", onOuterAbort);
          settle();
        };
        const onStall = () => {
          const timeout = new ServerTimeoutError(stallMs);
          controller.abort(timeout);
          finish(() => reject(timeout));
        };
        const rearm = () => {
          clearTimeout(timer);
          timer =
            waiting > 0 && !settled ? setTimeout(onStall, stallMs) : undefined;
        };
        const waits: ServerWaits = {
          begin() {
            waiting += 1;
            rearm();
          },
          end() {
            waiting = Math.max(0, waiting - 1);
            rearm();
          },
        };
        const onOuterAbort = () => {
          controller.abort(outer.reason);
          finish(() => reject(outer.reason));
        };
        if (outer.aborted) {
          onOuterAbort();
          return;
        }
        outer.addEventListener("abort", onOuterAbort, { once: true });
        let started: Promise<T>;
        try {
          started = operation(
            gitHttpClient(controller.signal, options.fetchImpl, waits),
          );
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        started.then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      }),
    { timeoutMs: options.timeoutMs ?? GIT_CAP_MS },
  );
}
