/**
 * What the money screens' unit tests share: a mocked server holding records, a wallet in the page that records every
 * call it is asked to send, and a render wrapper. Each test file mocks `src/lib/relay` with `relayMock` (vi.mock's
 * factory is hoisted, so it reaches this module only when a read runs).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { positionCallData } from "../../src/features/money/calls-v1";
import {
  type NumbersEvent,
  parseNumbers,
  type ProjectNumbers,
} from "../../src/features/money/numbers-v1";
import {
  type NumbersEvent as NumbersEventV2,
  parseNumbers as parseNumbersV2,
  type ProjectNumbers as ProjectNumbersV2,
} from "../../src/features/money/numbers";
import { ToastProvider } from "../../src/ui/toast";
import { BACKER_EVM, CONTRACTS, chainIdentity } from "./numbers-fixture";
import { chainIdentityV2 } from "./numbers-v2-fixture";

export const SERVER = "f".repeat(64);
export const NOW = Math.floor(Date.now() / 1000);
export const DAY = 86_400;
export const coordinateOf = (i: number) => `37001:${"b".repeat(64)}:p${i}`;
export const COORDINATE = coordinateOf(0);

interface Filter {
  kinds?: number[];
  authors?: string[];
  "#d"?: string[];
  limit?: number;
  until?: number;
}

interface Served {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** What the mocked server holds. */
export const served: Served[] = [];
export function serve(events: Served[]) {
  served.splice(0, served.length, ...events);
}

/** What the mocked server was asked to publish. */
export const published: unknown[] = [];

/** Answers like the relay: matching kinds, authors, #d and until, newest first, cut at `limit`. */
export async function readServed(filter: Filter) {
  return served
    .filter((e) => !filter.kinds || filter.kinds.includes(e.kind))
    .filter((e) => !filter.authors || filter.authors.includes(e.pubkey))
    .filter((e) => filter.until === undefined || e.created_at <= filter.until)
    .filter(
      (e) =>
        !filter["#d"] ||
        e.tags.some((t) => t[0] === "d" && filter["#d"]?.includes(t[1])),
    )
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, filter.limit ?? served.length);
}

/** `src/lib/relay` as the tests see it. A publish waits a moment, as a real one does, then is accepted. */
export const relayMock = {
  read: (filter: Filter) => readServed(filter),
  readMulti: async (filters: Filter[]) =>
    Promise.all(filters.map((f) => readServed(f))),
  readLatest: async (filter: Filter) => (await readServed(filter))[0] ?? null,
  publishAsUser: async (event: unknown) => {
    // The real one returns the signed record, which has its id (the hash a check-in carries).
    const signed = {
      ...(event as object),
      id: (published.length + 1).toString(16).padStart(64, "a"),
    };
    published.push(signed);
    await new Promise((r) => setTimeout(r, 20));
    return signed;
  },
};

export function record(
  content: Record<string, unknown>,
  coordinate = COORDINATE,
  at = NOW,
): NumbersEvent {
  return {
    id: `${at.toString(16)}${coordinate.slice(-3)}`.padStart(64, "0"),
    pubkey: SERVER,
    kind: 39009,
    created_at: at,
    tags: [["d", chainIdentity(coordinate).key]],
    content: JSON.stringify(content),
  };
}

/** A founder's project record (kind 37001) naming the launch `chainKey`, made `at`. */
export function projectEvent(o: {
  author: string;
  id: string;
  name: string;
  chainKey: string;
  at?: number;
}): Served {
  const at = o.at ?? NOW - DAY;
  return {
    id: `${o.author.slice(0, 8)}${o.id}${at.toString(16)}`.padEnd(64, "0"),
    pubkey: o.author,
    kind: 37001,
    created_at: at,
    tags: [
      ["d", o.id],
      ["name", o.name],
      ["chain-key", o.chainKey],
    ],
    content: "{}",
  };
}

/** A version 2 record (kind 39009) for the project at `coordinate`, signed by the mocked server. */
export function recordV2(
  content: Record<string, unknown>,
  coordinate = COORDINATE,
  at = NOW,
): NumbersEventV2 {
  return {
    id: `${at.toString(16)}${coordinate.slice(-3)}`.padStart(64, "0"),
    pubkey: SERVER,
    kind: 39009,
    created_at: at,
    tags: [["d", chainIdentityV2(coordinate).key]],
    content: JSON.stringify(content),
  };
}

/** The parsed version 2 numbers of `content` for the default project; throws when it does not read. */
export function numbersV2Of(
  content: Record<string, unknown>,
): ProjectNumbersV2 {
  const parsed = parseNumbersV2(recordV2(content), SERVER, {
    coordinate: COORDINATE,
    chainKey: chainIdentityV2(COORDINATE).key,
  });
  if (!parsed || parsed.removed) throw new Error("not parsed");
  return parsed;
}

export function numbersOf(content: Record<string, unknown>): ProjectNumbers {
  const parsed = parseNumbers(record(content), SERVER, {
    coordinate: COORDINATE,
    chainKey: chainIdentity(COORDINATE).key,
  });
  if (!parsed || parsed.removed) throw new Error("not parsed");
  return parsed;
}

const POSITION_SELECTOR = positionCallData(0, BACKER_EVM).slice(0, 10);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

export interface WalletOptions {
  /** The `pendingFrom`th call sent from this page does not land (until `settle`). */
  pendingFrom?: number;
  /** The network the wallet starts on (the project's, 31337, unless given). */
  chain?: string;
  /** The account the wallet sends from (the backer's unless given); `switchAccount` changes it. */
  account?: string;
  /** What the network says of a hash this page never sent (eth_getTransactionByHash). */
  known?: (hash: string) => unknown;
  /** Hashes sent earlier (before this page) that have landed. */
  landedEarlier?: string[];
  /** eth_getTransactionCount for "latest" and "pending" (the number of calls sent from this page, unless given). */
  count?: { latest?: number; pending?: number };
  /** `Rounds.positionOf(round, me).ask` in raw dollars. */
  asked?: bigint;
}

/** Every call the wallet was asked to send, with the account it was sent from. */
export const sent: { from: string; to: string; data: string }[] = [];
let account = BACKER_EVM;
let stuck: number | undefined;

/** The call that was not landing lands now. */
export function settle() {
  stuck = undefined;
}

/** The person switches the wallet to another account. */
export function switchAccount(next: string) {
  account = next;
}

/**
 * A wallet in the page that answers at once (or never, for the `pendingFrom`th send). Off the project's network a read
 * answers nothing, as a real one does. A call sent from this page has the nonce of its place in `sent`.
 */
export function installWallet(options: WalletOptions = {}) {
  sent.length = 0;
  account = options.account ?? BACKER_EVM;
  stuck = options.pendingFrom;
  let chain = options.chain ?? "0x7a69";
  const ours = (hash: string) => {
    const n = Number.parseInt(hash, 16);
    return n >= 1 && n <= sent.length ? n : null;
  };
  (window as unknown as { ethereum: unknown }).ethereum = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts")
        return [account];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        chain = (params?.[0] as { chainId: string }).chainId;
        return null;
      }
      if (method === "eth_getTransactionByHash") {
        const hash = String(params?.[0]);
        const n = ours(hash);
        if (n !== null) return { hash, nonce: `0x${(n - 1).toString(16)}` };
        return options.known ? options.known(hash) : null;
      }
      if (method === "eth_getTransactionCount") {
        const tag = params?.[1] === "latest" ? "latest" : "pending";
        return `0x${(options.count?.[tag] ?? sent.length).toString(16)}`;
      }
      if (method === "eth_call") {
        if (chain !== "0x7a69") return "0x";
        const data = String((params?.[0] as { data: string }).data);
        if (data.startsWith(POSITION_SELECTOR))
          return `0x${word(options.asked ?? 0n)}${word(0)}${word(0)}${word(0)}`;
        return `0x${"0".repeat(24)}${CONTRACTS.quote.slice(2)}`;
      }
      if (method === "eth_sendTransaction") {
        const tx = params?.[0] as { to: string; data: string };
        sent.push({ from: account, to: tx.to, data: tx.data });
        return `0x${sent.length.toString(16).padStart(64, "0")}`;
      }
      if (method === "eth_getTransactionReceipt") {
        const hash = String(params?.[0]);
        if (options.landedEarlier?.includes(hash)) return { status: "0x1" };
        const n = ours(hash);
        if (n === null) return null; // not sent from this page
        if (n === stuck) return null;
        return { status: "0x1" };
      }
      throw { code: 4200, message: method };
    },
  };
}

export function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}
