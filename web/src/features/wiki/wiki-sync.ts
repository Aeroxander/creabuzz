/**
 * Live multi-user wiki editing: Yjs documents synced through the community
 * relay and snapshotted to the relay (kind:44001) on save.
 *
 * The live layer sends coalesced Yjs updates as short-lived relay events
 * (kind:20003) scoped to the page (`d` slug), so the relay's auth, membership
 * and real-time fan-out carry them — no peer-to-peer room, no NAT/TURN, and no
 * one learns another's IP. The document layer is transport-pluggable
 * (`lib/wiki-doc.ts`), so a native/Iroh transport can slot in later; this file
 * only supplies the relay-backed transport and the React binding.
 *
 * Durable history is unchanged: a save still publishes a kind:44001 revision,
 * and an offline editor converges from the newest saved revision on next open.
 * The live layer only narrows the window where two open editors see each other.
 *
 * Membership: the relay refuses non-member senders, and we re-check each
 * received update's signer against the published member list as defense in
 * depth (`lib/live-members.ts`). Live editing is off when this identity cannot
 * sign, or the relay publishes no member list to check against; the editor says
 * so (`lib/live-status.ts`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";

import {
  existingUserPubkey,
  hasNip07Provider,
  signAsUser,
} from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { subscribeChannel } from "@/features/channels/subscribe-channel";

import {
  WikiDocSync,
  type WikiSyncTransport,
  toBase64,
  wikiSyncUpdateFromEvent,
} from "./lib/wiki-doc";
import {
  KIND_NIP43_MEMBERSHIP_LIST,
  createMemberDirectory,
  loadMemberListWithRetry,
  newestMemberSet,
  type MemberDirectory,
} from "./lib/live-members";
import { PeerBook } from "./lib/live-peers";
import type { LiveStatus } from "./lib/live-status";
import {
  commitLocalEdit,
  seedSnapshot,
  type CommitResult,
} from "./lib/text-edit";

/** Ephemeral wiki live-sync events (relay-scoped, never stored). */
export const KIND_WIKI_SYNC = 20003;

/** How often coalesced updates are published — the "≤1/s" bound. */
const PUBLISH_THROTTLE_MS = 1_000;
/** Per-publish size target; a coalesced batch is sent whole if larger. */
const PUBLISH_MAX_BYTES = 24 * 1024;

/** One member directory per relay: it caches the list across page switches. */
const memberDirectories = new Map<string, MemberDirectory>();

function memberDirectoryFor(relayUrl: string): MemberDirectory {
  let directory = memberDirectories.get(relayUrl);
  if (!directory) {
    directory = createMemberDirectory({
      fetchMembers: async () =>
        newestMemberSet(
          await queryEvents(relayUrl, {
            kinds: [KIND_NIP43_MEMBERSHIP_LIST],
            limit: 5,
          }),
        ),
    });
    memberDirectories.set(relayUrl, directory);
  }
  return directory;
}

/**
 * The pubkey this browser signs as, without creating an identity: opening a
 * page must not mint a key. A NIP-07 extension counts as an identity.
 */
async function resolveSigningPubkey(): Promise<string | null> {
  const stored = existingUserPubkey();
  if (stored) return stored;
  if (!hasNip07Provider()) return null;
  try {
    return (await window.nostr?.getPublicKey()) ?? null;
  } catch {
    return null;
  }
}

interface RelayTransportOptions {
  relayUrl: string;
  slug: string;
  /** Community channel scope, when the page is bound to one. */
  channel: string | null;
  /** Deliver a received peer update (author pubkey, raw Yjs bytes). */
  onInbound: (author: string, update: Uint8Array) => void;
  /** Report the live subscription state ("open" / "reconnecting"). */
  onStatus: (status: "open" | "reconnecting") => void;
  /** Report a publish/sign failure so the UI can surface "cannot-sign". */
  onError: (error: unknown) => void;
}

/**
 * The relay-backed transport: subscribes to kind:20003 for this page and
 * publishes each coalesced update as a signed, page-scoped relay event. The
 * relay fans it out live and never stores it.
 */
class RelayWikiTransport implements WikiSyncTransport {
  private readonly options: RelayTransportOptions;
  private unsubscribe: (() => void) | null = null;

  constructor(options: RelayTransportOptions) {
    this.options = options;
  }

  /** Open the inbound subscription. Outbound is available immediately. */
  open(): void {
    const { relayUrl, slug, channel, onInbound, onStatus } = this.options;
    const tags: [string, string][] = [["d", slug]];
    if (channel) tags.push(["h", channel]);
    const filter: Parameters<typeof subscribeChannel>[1] = {
      kinds: [KIND_WIKI_SYNC],
      "#d": [slug],
    };
    this.unsubscribe = subscribeChannel(relayUrl, filter, {
      onEvent: (event: SignedNostrEvent) => {
        const update = wikiSyncUpdateFromEvent(event, slug, KIND_WIKI_SYNC);
        if (!update) return;
        onInbound(event.pubkey, update);
      },
      onStatus: (status) => {
        onStatus(status === "open" ? "open" : "reconnecting");
      },
    });
  }

  publish(update: Uint8Array): void {
    const { relayUrl, slug, channel, onError } = this.options;
    void (async () => {
      const tags: [string, string][] = [["d", slug]];
      if (channel) tags.push(["h", channel]);
      const signed = await signAsUser({
        kind: KIND_WIKI_SYNC,
        tags,
        content: toBase64(update),
      });
      const result = await publishEvent(relayUrl, signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        onError(new Error(result.message ?? "relay rejected the live update"));
      }
    })().catch(onError);
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * Bind a page slug to a Yjs document synced through the relay.
 *
 * Returns the live text content plus a setter that writes through to the
 * shared Y.Text (peers converge); the caller publishes to the relay on save.
 *
 * The setter splices only the range the user changed into the live text, so a
 * peer editing another part of the page is not overwritten. A genuine overlap
 * (both peers rewriting the same characters) is still last-writer-wins; a
 * CRDT-aware editor binding (`y-prosemirror` through TipTap's collaboration
 * extension) is the end state that removes even that case.
 */
export function useLiveWikiDoc(
  slug: string | null,
  initialContent: string,
  /** Event id of the saved snapshot `initialContent` came from — the seed key
   * that makes two browsers opening the same page converge to one copy. */
  snapshotId: string,
): {
  content: string;
  setContent: (value: string) => void;
  /**
   * Merge a snapshot saved elsewhere and return the merged text, so a save can
   * publish the union instead of overwriting the other side.
   */
  mergeRemoteSnapshot: (snapshot: string) => {
    result: CommitResult;
    content: string;
  };
  touched: boolean;
  /** VERIFIED community members editing live with us (0 when alone). */
  peers: number;
  /** Peers in the room that have not proved membership; they receive nothing. */
  strangers: number;
  /** Received updates dropped for being unsigned, invalid, or not from a member. */
  rejected: number;
  /** Whether live co-editing is running, and if not, why. */
  live: LiveStatus;
} {
  const docRef = useRef<Y.Doc | null>(null);
  const textRef = useRef<Y.Text | null>(null);
  /**
   * The snapshot the live document is known to be based on. Remote snapshots
   * are merged as the delta from this base to the new one, so another editor's
   * saved work interleaves with local edits instead of replacing them.
   */
  const snapshotBaseRef = useRef(initialContent);
  const [content, setContentState] = useState(initialContent);
  const [touched, setTouched] = useState(false);
  const [peers, setPeers] = useState(0);
  const [strangers, setStrangers] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [live, setLive] = useState<LiveStatus>({ state: "connecting" });
  const seededRef = useRef(false);
  /**
   * The last value handed to the controlled editor. A local keystroke is a delta
   * against this baseline, not against the live document, which peers keep
   * writing to.
   */
  const renderedRef = useRef(initialContent);

  const setRendered = useCallback((value: string) => {
    renderedRef.current = value;
    setContentState(value);
  }, []);

  useEffect(() => {
    if (!slug) return;
    const doc = new Y.Doc();
    docRef.current = doc;
    const text = doc.getText("content");
    textRef.current = text;
    snapshotBaseRef.current = initialContent;
    // Seed under a client id derived from the saved snapshot's event id, so
    // two browsers opening the same page insert the SAME items and converge
    // to one copy once they exchange state (`lib/text-edit.ts`).
    seedSnapshot(text, initialContent, snapshotId || initialContent);

    // Everything async below is fenced by this flag: the effect re-runs when
    // the page changes, and a result for the previous run must not touch the
    // new document or the new status.
    let disposed = false;
    const relayUrl = relayWsUrl();
    const book = new PeerBook();
    let rejectedCount = 0;
    let reportedRejected = 0;

    setLive({ state: "connecting" });
    setPeers(0);
    setStrangers(0);
    setRejected(0);

    const signingFailed = (error: unknown) => {
      if (disposed) return;
      console.warn("[wiki-sync] could not publish a live update", error);
      setLive({ state: "unavailable", reason: "cannot-sign" });
    };

    let sync: WikiDocSync | null = null;
    let transport: RelayWikiTransport | null = null;

    const onInbound = (author: string, update: Uint8Array) => {
      if (disposed || !sync) return;
      // Defense in depth: the relay already refuses non-member senders; re-check
      // the signer against the published list before applying page content.
      void (async () => {
        const directory = memberDirectoryFor(relayUrl);
        const verdict = await directory.check(author);
        if (disposed) return;
        if (verdict === "not-member") {
          rejectedCount += 1;
          return;
        }
        const advanced = sync.handleRemoteUpdate(author, update);
        if (advanced) {
          book.markVerified(author, author);
          setPeers(book.verifiedCount);
          setRendered(text.toString());
        }
      })().catch(() => {
        if (!disposed) rejectedCount += 1;
      });
    };

    const startLive = async () => {
      const me = await resolveSigningPubkey();
      if (disposed) return;
      if (!me) {
        setLive({ state: "unavailable", reason: "no-identity" });
        return;
      }
      const directory = memberDirectoryFor(relayUrl);
      const listState = await loadMemberListWithRetry(directory, {
        isCancelled: () => disposed,
      });
      if (disposed) return;
      if (listState === "no-list") {
        setLive({ state: "unavailable", reason: "no-member-list" });
        return;
      }
      if (listState === "error") {
        setLive({ state: "unavailable", reason: "member-list-error" });
        return;
      }
      if ((await directory.check(me)) !== "member") {
        if (!disposed) setLive({ state: "unavailable", reason: "not-member" });
        return;
      }
      if (disposed) return;

      transport = new RelayWikiTransport({
        relayUrl,
        slug,
        channel: null,
        onInbound,
        onStatus: (status) => {
          if (disposed) return;
          setLive(
            status === "open" ? { state: "verified" } : { state: "connecting" },
          );
        },
        onError: signingFailed,
      });
      sync = new WikiDocSync(doc, transport, {
        throttleMs: PUBLISH_THROTTLE_MS,
        maxBatchBytes: PUBLISH_MAX_BYTES,
        onRemoteChange: () => {
          if (!disposed) setRendered(text.toString());
        },
        onPeerUpdate: (author) => {
          if (disposed) return;
          book.markVerified(author, author);
          setPeers(book.verifiedCount);
        },
      });
      transport.open();
      sync.start();
      setLive({ state: "verified" });
    };
    void startLive().catch((error: unknown) => {
      console.warn("[wiki-sync] live co-editing failed to start", error);
      if (!disposed) setLive({ state: "unavailable", reason: "room-failed" });
    });

    const rejectedReporter = setInterval(() => {
      if (rejectedCount !== reportedRejected) {
        reportedRejected = rejectedCount;
        setRejected(rejectedCount);
      }
    }, 2_000);

    const onTextChange = () => {
      const value = text.toString();
      if (!seededRef.current) {
        // Initial render from the seed/snapshot — not a user edit.
        seededRef.current = true;
        setRendered(value);
        return;
      }
      setTouched(true);
      setRendered(value);
    };
    text.observe(onTextChange);
    setRendered(text.toString());
    seededRef.current = true;

    return () => {
      disposed = true;
      text.unobserve(onTextChange);
      clearInterval(rejectedReporter);
      sync?.stop();
      doc.destroy();
      docRef.current = null;
    };
  }, [slug, initialContent, snapshotId, setRendered]);

  /**
   * Merge a page snapshot published elsewhere (another tab, or another person's
   * save). Applied as a delta from the previous snapshot, which is what makes
   * two people editing different parts of a page converge without sharing a
   * live window.
   */
  const mergeRemoteSnapshot = useCallback(
    (snapshot: string): { result: CommitResult; content: string } => {
      const doc = docRef.current;
      const text = textRef.current;
      if (!doc || !text) return { result: "noop", content: snapshot };
      if (snapshot === snapshotBaseRef.current) {
        return { result: "noop", content: text.toString() };
      }
      let result: CommitResult = "noop";
      doc.transact(() => {
        result = commitLocalEdit(text, snapshotBaseRef.current, snapshot);
      }, "remote");
      snapshotBaseRef.current = snapshot;
      const content = text.toString();
      setRendered(content);
      return { result, content };
    },
    [setRendered],
  );

  const setContent = useCallback(
    (value: string) => {
      const doc = docRef.current;
      const text = textRef.current;
      if (!doc || !text) return;
      // Splice only what the user changed, so a peer's concurrent edits to
      // other parts of the page survive (see `lib/text-edit.ts`).
      doc.transact(() => {
        commitLocalEdit(text, renderedRef.current, value);
      }, "local");
      setRendered(value);
    },
    [setRendered],
  );

  return {
    content,
    setContent,
    mergeRemoteSnapshot,
    touched,
    peers,
    strangers,
    rejected,
    live,
  };
}
