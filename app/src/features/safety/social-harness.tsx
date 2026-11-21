/**
 * What the social screens' component tests share: a server that holds events and answers a filter the way the real one does
 * (kinds, authors, ids, `#e`, `#t`, a word search, newest first, cut at `limit`), keeps only the newest of a replaceable list,
 * and a stand-in for the person's own sealing of private lists. A test file mocks `../../lib/relay`, `../../lib/account` and
 * `@creaton/core/client/identity.ts` with the three mocks here.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "../../ui/toast";
import type { SignedEvent } from "../posts/use-posts";

export const ME = "1".repeat(64);
export const ANA = "2".repeat(64);
export const BO = "3".repeat(64);
export const KEY = `0x${"cd".repeat(32)}`;
export const NOW = Math.floor(Date.now() / 1000);

type Filter = Record<string, unknown> & { kinds?: number[]; limit?: number };

export const world = {
  events: [] as SignedEvent[],
  published: [] as SignedEvent[],
  me: ME,
  signedIn: true,
  /** A passkey account that needs its one tap after a reload (the app's own `useAccount().locked`). */
  passkeyLocked: false,
  /** The person's key cannot be used (a locked passkey): opening a sealed list rejects. */
  locked: false,
  /** Words asked for with `search`, in order. */
  searches: [] as string[],
  /** Every read's filter, in order. */
  reads: [] as Filter[],
  /** A read of these kinds fails. */
  failKinds: [] as number[],
  /** A read with a `search` fails. */
  failSearch: false,
  /** The kinds the server's word index covers (a fresh server: profiles only); null means every kind. */
  indexed: null as number[] | null,
  /** A read of a kind answers this many milliseconds late (to make one list arrive before another). */
  slow: {} as Record<number, number>,
  /** Writes are refused with this reason. */
  refuse: null as string | null,
  /** Each write waits this long before it is taken (to hold two changes in flight). */
  writeDelayMs: 5,
  /** Where a navigation went. */
  navigated: [] as unknown[],
};

let counter = 0;
export const nextId = () => (++counter).toString(16).padStart(64, "0");

export function reset() {
  world.events = [];
  world.published = [];
  world.me = ME;
  world.signedIn = true;
  world.passkeyLocked = false;
  world.locked = false;
  world.searches = [];
  world.reads = [];
  world.failKinds = [];
  world.failSearch = false;
  world.slow = {};
  world.indexed = null;
  world.refuse = null;
  world.writeDelayMs = 5;
  world.navigated = [];
  localStorage.clear();
}

const REPLACEABLE = [0, 3, 10000, 10003, 10050];

const has = (e: SignedEvent, name: string, values: unknown) =>
  !Array.isArray(values) ||
  e.tags.some((t) => t[0] === name && values.includes(t[1]));

function query(filter: Filter): SignedEvent[] {
  if (filter.kinds?.some((k) => world.failKinds.includes(k)))
    throw new Error("The server did not answer.");
  const search =
    typeof filter.search === "string" ? filter.search.toLowerCase() : null;
  if (search !== null) {
    if (world.failSearch) throw new Error("The server did not answer.");
    world.searches.push(search);
  }
  return world.events
    .filter((e) => !filter.kinds || filter.kinds.includes(e.kind))
    .filter(
      (e) =>
        !Array.isArray(filter.authors) || filter.authors.includes(e.pubkey),
    )
    .filter((e) => !Array.isArray(filter.ids) || filter.ids.includes(e.id))
    .filter(
      (e) =>
        search === null ||
        world.indexed === null ||
        world.indexed.includes(e.kind),
    )
    .filter((e) => has(e, "e", filter["#e"]) && has(e, "t", filter["#t"]))
    .filter(
      (e) =>
        search === null ||
        search.split(/\s+/).every((w) => e.content.toLowerCase().includes(w)),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
    .slice(0, filter.limit ?? 1000);
}

export const relayMock = {
  read: async (filter: Filter) => {
    world.reads.push(filter);
    const late = Math.max(
      0,
      ...(filter.kinds ?? []).map((k) => world.slow[k] ?? 0),
    );
    if (late > 0) await new Promise((r) => setTimeout(r, late));
    return query(filter);
  },
  readMulti: async (filters: Filter[]) =>
    filters.map((f) => {
      world.reads.push(f);
      return query(f);
    }),
  readLatest: async (kind: number, author: string) => {
    const late = world.slow[kind] ?? 0;
    if (late > 0) await new Promise((r) => setTimeout(r, late));
    return query({ kinds: [kind], authors: [author] })[0] ?? null;
  },
  publishAsUser: async (template: {
    kind: number;
    tags: string[][];
    content: string;
    created_at?: number;
  }) => {
    await new Promise((r) => setTimeout(r, world.writeDelayMs));
    if (world.refuse) throw new Error(world.refuse);
    const event = {
      id: nextId(),
      pubkey: world.me,
      sig: "",
      created_at: NOW,
      ...template,
    } as SignedEvent;
    world.published.push(event);
    // The server keeps only the newest of a list that replaces itself.
    if (REPLACEABLE.includes(event.kind))
      world.events = world.events.filter(
        (e) => !(e.kind === event.kind && e.pubkey === event.pubkey),
      );
    world.events.push(event);
    return event;
  },
};

export const accountMock = {
  useAccount: () => ({
    pubkey: world.signedIn ? world.me : null,
    locked: world.passkeyLocked,
  }),
};

/** A stand-in for the sealing: the shape the list's own checks need (base64, version byte 2, long enough), nothing secret. */
const seal = (plain: string) => `AgAA${btoa(plain + " ".repeat(80))}`;
const open = (sealed: string) => atob(sealed.slice(4));
export const sealed = seal;
export const unsealed = open;
export const identityMock = {
  signAsUser: async (template: object) => ({
    ...template,
    id: nextId(),
    pubkey: world.me,
    sig: "",
  }),
  existingUserPubkey: () => (world.signedIn ? world.me : null),
  nip44EncryptAsUser: async (_peer: string, plain: string) => {
    if (world.locked) throw new Error("Your passkey is locked.");
    return seal(plain);
  },
  nip44DecryptAsUser: async (_peer: string, text: string) => {
    if (world.locked) throw new Error("Your passkey is locked.");
    return open(text);
  },
};

/** The router the screens draw their links with: plain anchors that say where they go, and a navigation that is recorded. */
export const routerMock = async (actual: () => Promise<object>) => ({
  ...(await actual()),
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
    "aria-label"?: string;
    "data-testid"?: string;
    className?: string;
  }) => (
    <a
      aria-label={rest["aria-label"]}
      className={rest.className}
      data-testid={rest["data-testid"]}
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
  createLink: () =>
    function ButtonLinkStub({ children }: { children: ReactNode }) {
      return <a href="/x">{children}</a>;
    },
  useNavigate: () => (target: unknown) => {
    world.navigated.push(target);
  },
  useRouter: () => ({
    history: { back: () => undefined },
    navigate: () => undefined,
  }),
  useRouterState: () => "/x",
});

/** A stored event. */
export function stored(
  pubkey: string,
  kind: number,
  tags: string[][],
  content: string,
  at: number,
): SignedEvent {
  const event = {
    id: nextId(),
    pubkey,
    kind,
    tags,
    content,
    created_at: at,
    sig: "",
  } as SignedEvent;
  world.events.push(event);
  return event;
}

export const note = (
  pubkey: string,
  content: string,
  at = NOW - 100,
  tags: string[][] = [],
) => stored(pubkey, 1, tags, content, at);

export const profile = (pubkey: string, name: string, about = "") =>
  stored(pubkey, 0, [], JSON.stringify({ name, about }), NOW - 1000);

/** The person's own private mute list holding these people. */
export function hide(...people: string[]) {
  stored(
    world.me,
    10000,
    [],
    seal(JSON.stringify(people.map((p) => ["p", p]))),
    NOW - 500,
  );
}

export function draw(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
