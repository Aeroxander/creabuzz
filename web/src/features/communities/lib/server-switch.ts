/**
 * Moving this browser to a community on another server, checked before anything is saved.
 *
 * The saved address decides which server every screen talks to, and the switch reloads the page. Saving an address
 * nobody answers at would reload into an app that cannot load anything, so: the address must read as a server
 * address, the server must accept a connection in a bounded time, and only then is the address saved.
 *
 * Alias-free for `node --test`.
 */

import { normalizeRelayWsUrl } from "../../../shared/lib/relay-url.ts";

/** How long a server gets to answer before it is treated as not answering. */
const SERVER_CHECK_TIMEOUT_MS = 8_000;

export type ServerAddress =
  | { ok: true; wsUrl: string; host: string }
  | { ok: false; problem: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isLocalName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** A host name a server can be reached at: a dotted name, a local name, or an IP address. */
function plausibleHostname(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true; // IPv6, already parsed by URL
  if (isIpv4(hostname) || isLocalName(hostname)) return true;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;
  // The last part is a domain ending (com, app, ...), never only digits.
  return /[a-z]/i.test(labels[labels.length - 1]);
}

/**
 * Read what someone typed as a server address. Accepts a bare host (`community.example.com`, `host:3000`) or a full
 * address (`https://...`, `wss://...`); refuses anything that is not one, with words saying why.
 */
export function parseServerAddress(input: string): ServerAddress {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, problem: "Enter a server address." };
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      problem: "A server address has no spaces, like community.example.com.",
    };
  }
  const wsUrl = normalizeRelayWsUrl(trimmed);
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return {
      ok: false,
      problem:
        "That doesn't look like a server address, like community.example.com.",
    };
  }
  if (url.username || url.password) {
    return { ok: false, problem: "Leave out any name or password." };
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return {
      ok: false,
      problem:
        "Enter only the server's address, without a page or path after it.",
    };
  }
  if (!plausibleHostname(url.hostname)) {
    return {
      ok: false,
      problem:
        "That doesn't look like a server address, like community.example.com.",
    };
  }
  return { ok: true, wsUrl: `${url.protocol}//${url.host}`, host: url.host };
}

export type ServerCheck = { ok: true } | { ok: false; problem: string };

/** The part of a browser WebSocket the check uses, so tests can stand in for a server. */
export type ProbeSocket = {
  addEventListener(
    type: "open" | "error" | "close",
    listener: () => void,
  ): void;
  close(): void;
};

/**
 * Open a connection to the server the way the app will talk to it, giving up after `timeoutMs`, then hang up.
 *
 * A connection, not a page request: a browser only lets this page read another server's pages when that server
 * allows this page's address, and community servers allow only their own. Connections are not limited that way, and
 * a connection that opens is exactly what the app needs after the switch. A parked or dead address never opens one
 * (it answers with a web page, an error, or nothing), so nothing is saved for it. `signal` stops the check early when
 * the page no longer wants the answer, and the connection is closed.
 */
export function checkServer(
  wsUrl: string,
  {
    connect = (url: string): ProbeSocket => new WebSocket(url),
    timeoutMs = SERVER_CHECK_TIMEOUT_MS,
    signal,
  }: {
    connect?: (url: string) => ProbeSocket;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ServerCheck> {
  const host = new URL(wsUrl).host;
  const notAnswering: ServerCheck = {
    ok: false,
    problem: `${host} didn't answer as a community server. Check the address and try again.`,
  };
  const tooSlow: ServerCheck = {
    ok: false,
    problem: `${host} didn't answer in time. Check the address and try again.`,
  };
  const stopped: ServerCheck = { ok: false, problem: "The check was stopped." };
  if (signal?.aborted) return Promise.resolve(stopped);

  let socket: ProbeSocket;
  try {
    socket = connect(wsUrl);
  } catch {
    // The browser refused to even try (an address it will not connect to from this page).
    return Promise.resolve(notAnswering);
  }

  return new Promise<ServerCheck>((resolve) => {
    let settled = false;
    const finish = (result: ServerCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // Already closed; the answer stands.
      }
      resolve(result);
    };
    const onAbort = () => finish(stopped);
    const timer = setTimeout(() => finish(tooSlow), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => finish({ ok: true }));
    socket.addEventListener("error", () => finish(notAnswering));
    socket.addEventListener("close", () => finish(notAnswering));
  });
}

/**
 * Save the checked address. Returns words for the person when the browser refuses to keep it (private browsing with
 * storage blocked), so the page can say so instead of reloading onto the old server as if it had worked.
 */
export function saveServerAddress(
  wsUrl: string,
  save: (wsUrl: string) => void,
): string | null {
  try {
    save(wsUrl);
    return null;
  } catch {
    return "This browser didn't let the address be saved. Allow this site to store data, then try again.";
  }
}
