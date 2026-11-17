/**
 * One deadline for every HTTP read and write this app sends to its server.
 *
 * A plain `fetch` has no deadline: a connection that is accepted and then never answered (a dropped network, a stuck
 * proxy) leaves the screen waiting forever. Every request through here ends by its deadline with a
 * {@link ServerTimeoutError}, which the failure table in `relay-failure.ts` reads as "nobody answered" (it carries no
 * server wording), so the screen says the server did not answer rather than spinning or showing an empty list.
 *
 * A caller's own `signal` is honoured too: when the caller gives up (a newer search, a closed page), the request stops
 * with the caller's own abort reason, never with "did not answer", so a stale request is dropped quietly instead of
 * being shown as a failure.
 *
 * Also here, because every caller of a server or node needs them: reading `Retry-After` for loops that already ask
 * again on 429/503 (bounded: a server that asks for a longer wait than the loop will make ends the loop), and checking
 * that a `/query` reply really is a list of signed records before anything renders it.
 *
 * Pure: no Vite aliases, no DOM beyond `AbortController`, so the node test runner imports it directly.
 */

/** How long a request may take, start to finish, unless the caller says otherwise. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The words a timed-out request ends in. */
export const SERVER_DID_NOT_ANSWER =
  "The server did not answer in time. Check your connection and try again.";

/**
 * A request that reached its deadline with no answer. It carries no server wording on purpose: the failure table
 * classifies it as unanswered.
 */
export class ServerTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(SERVER_DID_NOT_ANSWER);
    this.name = "ServerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Whether an error is a request that ran out of time (as opposed to the caller giving up). */
export function isServerTimeout(error: unknown): error is ServerTimeoutError {
  return error instanceof ServerTimeoutError;
}

export interface DeadlineOptions {
  /** Milliseconds before the request is given up; {@link DEFAULT_TIMEOUT_MS} when left out. */
  timeoutMs?: number;
  /** The caller's own signal: when it aborts, the request stops with the caller's reason. */
  signal?: AbortSignal | null;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The request was cancelled.", "AbortError")
  );
}

/**
 * Run `work` with a signal that aborts at the deadline or when the caller's signal aborts, whichever is first.
 *
 * The returned promise settles by the deadline even when `work` ignores its signal, so a request can never outlive
 * it. The timer and the listener on the caller's signal are always removed.
 */
export function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outer = options.signal ?? null;
  if (outer?.aborted) return Promise.reject(abortReason(outer));

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
      settle();
    };
    const onOuterAbort = () => {
      const reason = abortReason(outer as AbortSignal);
      controller.abort(reason);
      finish(() => reject(reason));
    };
    const timer = setTimeout(() => {
      const timeout = new ServerTimeoutError(timeoutMs);
      controller.abort(timeout);
      finish(() => reject(timeout));
    }, timeoutMs);
    outer?.addEventListener("abort", onOuterAbort, { once: true });

    let started: Promise<T>;
    try {
      started = work(controller.signal);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    started.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export interface TimedFetchInit extends RequestInit, DeadlineOptions {
  /** The fetch to use; the global one when left out (tests pass their own). */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}

function fetchWith(
  input: string,
  init: TimedFetchInit,
): (signal: AbortSignal) => Promise<Response> {
  const { timeoutMs: _timeout, signal: _signal, fetchImpl, ...request } = init;
  const doFetch =
    fetchImpl ?? ((url: string, req: RequestInit) => fetch(url, req));
  return (signal) => doFetch(input, { ...request, signal });
}

/**
 * `fetch` with a deadline on the answer's headers only. The caller's signal is honoured until the headers arrive; a
 * body read after that is under neither the deadline nor the caller's signal. Prefer {@link timedFetchBody} when the
 * whole reply is read at once as text or JSON, and {@link timedFetchStreamed} when the body is read later by someone
 * else (a picture as a blob), so the body read is bounded too.
 */
export function timedFetch(
  input: string,
  init: TimedFetchInit = {},
): Promise<Response> {
  return withDeadline(fetchWith(input, init), init);
}

/**
 * `fetch` whose deadline and caller signal cover the body as well as the headers, while the body stays unread until
 * the caller reads it (so a caller can still refuse a reply by its headers without downloading it).
 *
 * The answer is a fresh `Response` with the same status, status text and headers, whose body is the server's body
 * watched by the deadline: a body that stalls past the deadline fails its read with {@link ServerTimeoutError}, and a
 * caller who gives up mid-body fails it with the caller's own reason. The timer and listener end when the body is
 * fully read. A reply without a body (or one that cannot be rebuilt, such as an opaque one) is passed through as is.
 */
export function timedFetchStreamed(
  input: string,
  init: TimedFetchInit = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outer = init.signal ?? null;
  if (outer?.aborted) return Promise.reject(abortReason(outer));
  const send = fetchWith(input, init);
  const controller = new AbortController();
  let rejectHeaders: ((reason: unknown) => void) | null = null;
  let bodyController: TransformStreamDefaultController<Uint8Array> | null =
    null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  };
  const stop = (reason: unknown) => {
    if (ended) return;
    end();
    controller.abort(reason);
    rejectHeaders?.(reason);
    try {
      bodyController?.error(reason);
    } catch {
      // The body was already closed or cancelled by its reader; nothing is left to stop.
    }
  };
  const onOuterAbort = () => stop(abortReason(outer as AbortSignal));
  const timer = setTimeout(
    () => stop(new ServerTimeoutError(timeoutMs)),
    timeoutMs,
  );
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  return new Promise<Response>((resolve, reject) => {
    rejectHeaders = reject;
    let started: Promise<Response>;
    try {
      started = send(controller.signal);
    } catch (error) {
      end();
      reject(error);
      return;
    }
    started.then(
      (response) => {
        if (ended) return;
        rejectHeaders = null;
        const body = response.body;
        if (!body || response.status < 200 || response.status > 599) {
          end();
          resolve(response);
          return;
        }
        const watched = new TransformStream<Uint8Array, Uint8Array>({
          start(c) {
            bodyController = c;
          },
          flush() {
            end();
          },
        });
        resolve(
          new Response(body.pipeThrough(watched), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        );
      },
      (error) => {
        end();
        reject(error);
      },
    );
  });
}

/** A reply read whole: its status, headers and body (parsed JSON, or the raw text when it is not JSON). */
export interface TimedReply {
  response: Response;
  /** The body parsed as JSON; `undefined` when it was empty or not JSON. */
  json: unknown;
  /** The body as text. */
  text: string;
}

/** `fetch` and read the whole body, all under one deadline: a reply whose body never finishes also times out. */
export function timedFetchBody(
  input: string,
  init: TimedFetchInit = {},
): Promise<TimedReply> {
  const send = fetchWith(input, init);
  return withDeadline(async (signal) => {
    const response = await send(signal);
    const text = await response.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { response, json, text };
  }, init);
}

/** The longest wait a `Retry-After` may ask of a loop that asks again on its own. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * A `Retry-After` value in milliseconds: whole seconds (`"5"`) or an HTTP date. `null` when absent or unreadable;
 * a date already past is 0.
 */
export function retryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  // An HTTP date names its weekday and month; a bare number with a sign or a point is not one.
  if (!/[a-z]/i.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** `Retry-After` off a reply that may not carry headers at all (a test double, an opaque reply). */
export function retryAfterOf(
  response: { status: number; headers?: { get(name: string): string | null } },
  nowMs: number = Date.now(),
): number | null {
  if (response.status !== 429 && response.status !== 503) return null;
  const header = response.headers?.get?.("retry-after") ?? null;
  return retryAfterMs(header, nowMs);
}

/**
 * How long a retry loop should pause, given its own planned pause and what the server asked for.
 *
 * The longer of the two, so a loop never asks again sooner than the server said. `null` when the server asked for
 * more than `capMs`: the loop then stops and reports the failure instead of waiting minutes (or asking early).
 */
export function retryPause(
  plannedMs: number,
  serverAskedMs: number | null,
  capMs: number = MAX_RETRY_AFTER_MS,
): number | null {
  if (serverAskedMs === null) return plannedMs;
  if (serverAskedMs > capMs) return null;
  return Math.max(plannedMs, serverAskedMs);
}

/** The fields every signed record carries. */
export interface SignedRecordShape {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function isSignedRecord(value: unknown): value is SignedRecordShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.pubkey === "string" &&
    typeof record.sig === "string" &&
    typeof record.content === "string" &&
    typeof record.kind === "number" &&
    Number.isInteger(record.kind) &&
    typeof record.created_at === "number" &&
    Number.isFinite(record.created_at) &&
    Array.isArray(record.tags) &&
    record.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string"),
    )
  );
}

/**
 * Whether a `/query` reply is a list of signed records. Anything else (an error object with status 200, a proxy's
 * HTML page, one malformed record) is refused whole: rendering half of a wrong reply would be worse than saying it
 * could not be read.
 */
export function isSignedRecordList(body: unknown): body is SignedRecordShape[] {
  return Array.isArray(body) && body.every(isSignedRecord);
}
