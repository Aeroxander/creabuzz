/**
 * Telling the people who run this app when it breaks, without telling them anything about its users.
 *
 * Off unless the build names a collector (`VITE_ERROR_REPORT_URL`). When it does, an uncaught error, a promise that
 * failed with nobody listening, or a screen that crashed is sent as a small JSON note: what went wrong, where in the app
 * (the page's path only: no query, no fragment, no community address), and when. Nothing else leaves the browser: no
 * account, no keys, no messages, no wallet addresses, and anything in the error text that looks like a key or a 64-digit
 * id is blanked before it is sent. Reports are limited (a few a minute, a few dozen a session, the same error once) so
 * a broken screen cannot flood the collector, and a failed send is forgotten: reporting never breaks the app it is
 * reporting on.
 *
 * Alias-free and pure apart from `installErrorReporting`, which takes everything it touches as arguments: covered by
 * `error-report.test.mjs`.
 */

/**
 * `handled`: a failure the screen caught and showed in words, but that the people running the site need to hear about
 * because nobody on the page can fix it (sponsored fees refused, the chain node failing). Told once per cause a visit.
 */
export type ReportKind = "error" | "rejection" | "render" | "handled";

export interface ErrorReport {
  kind: ReportKind;
  message: string;
  stack: string;
  /** The path of the page, without query or fragment. */
  page: string;
  /** Unix seconds. */
  at: number;
  /** What build this was, when the build says. */
  release: string;
}

export const MAX_MESSAGE = 300;
export const MAX_STACK = 2000;
/** Most reports in one rolling minute. */
export const MAX_PER_MINUTE = 5;
/** Most reports in one visit to the app. */
export const MAX_PER_SESSION = 30;

/** Blank what must never leave the browser: secret keys, 64-digit ids and addresses, and wallet addresses. */
export function scrub(text: string): string {
  return text
    .replace(/\bnsec1[0-9a-z]{20,}/gi, "[key]")
    .replace(/\bnpub1[0-9a-z]{20,}/gi, "[key]")
    .replace(/\b0x[0-9a-f]{40,}\b/gi, "[address]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[id]");
}

/**
 * The collector's address, or null when reporting is off. Only `https` is accepted (and plain `http` for a collector on
 * this machine), because an error note should not cross a network in the clear.
 */
export function reportEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? "" };
  }
  if (typeof error === "string") return { message: error, stack: "" };
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: "" };
  } catch {
    return { message: String(error), stack: "" };
  }
}

/** The note for one error: scrubbed and cut to length. */
export function makeReport(input: {
  kind: ReportKind;
  error: unknown;
  /** `location.pathname`; anything after a `?` or `#` is dropped anyway. */
  page: string;
  now: number;
  release?: string;
}): ErrorReport {
  const { message, stack } = describe(input.error);
  return {
    kind: input.kind,
    message: scrub(message).slice(0, MAX_MESSAGE),
    stack: scrub(stack).slice(0, MAX_STACK),
    page: scrub(input.page.split(/[?#]/)[0] ?? "").slice(0, 200),
    at: Math.floor(input.now / 1000),
    release: (input.release ?? "").slice(0, 40),
  };
}

export interface Reporter {
  /**
   * Report an error. Returns whether it was sent (not limited, not a repeat). `cause`, when given, is what counts as a
   * repeat instead of the text: a cause is told once a visit, whatever its error says each time.
   */
  report: (kind: ReportKind, error: unknown, cause?: string) => boolean;
}

/**
 * The limits around sending. `send` is called for a report that passes them; it must not throw into the caller, and
 * this wraps it so that even one that does is forgotten.
 */
export function createReporter(options: {
  send: (report: ErrorReport) => void;
  page: () => string;
  now: () => number;
  release?: string;
}): Reporter {
  const sentAt: number[] = [];
  const seen = new Set<string>();
  return {
    report(kind, error, cause) {
      const now = options.now();
      const report = makeReport({
        kind,
        error,
        page: options.page(),
        now,
        release: options.release,
      });
      // The same error is told once, however many times it happens.
      const identity =
        cause !== undefined
          ? `${report.kind}|cause|${cause}`
          : `${report.kind}|${report.message}|${report.stack.split("\n")[1] ?? report.stack}`;
      if (seen.has(identity)) return false;
      const recent = sentAt.filter((t) => now - t < 60_000);
      if (recent.length >= MAX_PER_MINUTE || sentAt.length >= MAX_PER_SESSION) {
        return false;
      }
      seen.add(identity);
      sentAt.push(now);
      try {
        options.send(report);
      } catch {
        // Reporting must never break the app.
      }
      return true;
    },
  };
}

/** The reporter in use, so a screen that catches its own crash can report it too. Null while reporting is off. */
let installed: Reporter | null = null;

/** Report a crash that a screen caught (the route error view). Does nothing while reporting is off. */
export function reportRenderError(error: unknown): void {
  installed?.report("render", error);
}

/**
 * Report a failure the screen already handled (it showed the person what happened) but that only the site's organiser can
 * fix, once a visit per `cause` (for example "sponsor-refused" or "chain-busy"). The message carries `cause` first, so a
 * note says which it was. Does nothing while reporting is off; never throws.
 */
export function reportHandledFailure(cause: string, error: unknown): boolean {
  if (!installed) return false;
  const detail =
    error instanceof Error
      ? (error as Error & { detail?: unknown }).detail
      : undefined;
  const { message, stack } = describe(error);
  const text = `${cause}: ${typeof detail === "string" && detail ? detail : message}`;
  const wrapped = new Error(text);
  wrapped.stack = stack;
  return installed.report("handled", wrapped, cause);
}

/**
 * Start reporting. Returns a function that stops it. `target` is the window, `fetchImpl` the browser's `fetch`; both are
 * arguments so the whole thing can be driven by a test.
 */
export function installErrorReporting(options: {
  endpoint: string | null;
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  fetchImpl: (url: string, init: Record<string, unknown>) => unknown;
  page: () => string;
  now?: () => number;
  release?: string;
}): () => void {
  if (!options.endpoint) return () => {};
  const endpoint = options.endpoint;
  const reporter = createReporter({
    send: (report) => {
      // Not awaited and not waited on: a collector that is slow or down changes nothing for the person using the app.
      const sent = options.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
        keepalive: true,
        credentials: "omit",
      });
      if (sent && typeof (sent as Promise<unknown>).catch === "function") {
        (sent as Promise<unknown>).catch(() => {});
      }
    },
    page: options.page,
    now: options.now ?? (() => Date.now()),
    release: options.release,
  });
  const onError = (event: { error?: unknown; message?: string }) =>
    void reporter.report("error", event.error ?? event.message ?? "error");
  const onRejection = (event: { reason?: unknown }) =>
    void reporter.report("rejection", event.reason ?? "unhandled rejection");
  options.target.addEventListener("error", onError as EventListener);
  options.target.addEventListener(
    "unhandledrejection",
    onRejection as EventListener,
  );
  installed = reporter;
  return () => {
    options.target.removeEventListener("error", onError as EventListener);
    options.target.removeEventListener(
      "unhandledrejection",
      onRejection as EventListener,
    );
    if (installed === reporter) installed = null;
  };
}
