/**
 * Live multi-user wiki editing: Yjs documents synced peer-to-peer over
 * Trystero (WebRTC with the community relay as Nostr signaling only) and
 * snapshotted to the relay (kind:44001) on save.
 *
 * Protocol (y-webrtc-style): connect → announce → when a peer proves it is a
 * community member, send it the full state; live edits broadcast as throttled
 * Yjs update deltas; every received update that taught us something echoes our
 * state back (throttled) so late joiners fully converge. The relay stays the
 * durable source of truth via explicit saves.
 *
 * Authentication: the room is joinable by anyone who knows the relay and the
 * slug, so EVERY message travels in a signed envelope and is applied only when
 * its signer is a community member (`lib/live-auth.ts` documents the envelope
 * and the accept rules; `lib/live-apply.ts` is the single path from a message
 * to the document). Page content is only ever sent to peers that have proved
 * membership; a peer that has not is sent nothing. Live editing is off when
 * this identity cannot sign, or the relay publishes no member list to check
 * peers against; the editor says so (`lib/live-status.ts`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { joinRoom, selfId } from "trystero/nostr";

import {
  existingUserPubkey,
  hasNip07Provider,
  signAsUser,
} from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  LiveSignError,
  createLiveReceiver,
  liveRoomId,
  signEnvelope,
  type LiveEnvelope,
} from "./lib/live-auth";
import { receiveIntoDoc } from "./lib/live-apply";
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

const APP_ID = "buzz-wiki";

/** An empty Yjs update: a "hello" that proves who we are and carries no content. */
const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());
/** A signed hello is bound to our peer id, not the recipient, so it is reusable. */
const HELLO_REUSE_MS = 120_000;

interface WikiAction {
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
  send: (
    data: unknown,
    options?: { target?: string | string[] | null },
  ) => unknown;
}

interface RoomHandle {
  action: WikiAction;
  raw: {
    onPeerJoin: ((id: string) => void) | null;
    onPeerLeave: ((id: string) => void) | null;
    getPeers: () => Record<string, unknown>;
  };
  destroy: () => void;
}

function openRoom(roomId: string): RoomHandle | null {
  try {
    const room = joinRoom(
      { appId: APP_ID, relayConfig: { urls: [relayWsUrl()] } },
      roomId,
    );
    return {
      action: room.makeAction("updates") as unknown as WikiAction,
      raw: room as unknown as RoomHandle["raw"],
      destroy: () => {
        void room.leave();
      },
    };
  } catch (error) {
    console.warn("[wiki-sync] joinRoom failed", error);
    return null;
  }
}

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

/**
 * Bind a page slug to a Yjs document synced over Trystero.
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
  /**
   * Verified editing peers, excluding this tab.
   *
   * Peer-to-peer editing needs the relay to accept the trystero signalling
   * events (`BUZZ_P2P_SIGNALING`), so "editing alone" is the honest state on a
   * relay that has not enabled them — and without surfacing it the feature
   * looks broken rather than unavailable.
   */
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
    const roomId = liveRoomId(slug);
    const relayUrl = relayWsUrl();
    const book = new PeerBook();
    let room: RoomHandle | null = null;
    let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    let echoTimer: ReturnType<typeof setTimeout> | null = null;
    let rejectedCount = 0;
    let reportedRejected = 0;
    const pendingUpdate: Uint8Array[] = [];
    let hello: Promise<LiveEnvelope> | null = null;
    let helloAt = 0;

    setLive({ state: "connecting" });
    setPeers(0);
    setStrangers(0);
    setRejected(0);

    const syncCounts = () => {
      if (disposed || !room) return;
      const total = Object.keys(room.raw.getPeers()).length;
      setPeers(book.verifiedCount);
      setStrangers(Math.max(0, total - book.verifiedCount));
    };

    const signingFailed = (error: unknown) => {
      if (disposed) return;
      console.warn("[wiki-sync] could not sign a live update", error);
      setLive({
        state: "unavailable",
        reason:
          error instanceof LiveSignError && error.reason === "too-large"
            ? "too-large"
            : "cannot-sign",
      });
    };

    /** A signature worked again: leave a "cannot sign" state we set ourselves. */
    const signingWorked = () => {
      setLive((current) =>
        current.state === "unavailable" && current.reason === "cannot-sign"
          ? { state: "verified" }
          : current,
      );
    };

    const sendEnvelope = (envelope: LiveEnvelope, targets: string[]) => {
      const handle = room;
      if (disposed || !handle) return;
      void Promise.resolve(
        handle.action.send(envelope, { target: targets }),
      ).catch((error: unknown) => {
        console.warn("[wiki-sync] live send failed", error);
      });
    };

    /** Sign an update and send it to these peers only (verified ones). */
    const sendSigned = (bytes: Uint8Array, targets: string[]) => {
      if (disposed || !room || targets.length === 0) return;
      void signEnvelope({
        room: roomId,
        peer: selfId,
        update: bytes,
        sign: (template) => signAsUser(template),
        nowSecs: Math.floor(Date.now() / 1000),
      })
        .then((envelope) => {
          if (disposed) return;
          signingWorked();
          sendEnvelope(envelope, targets);
        })
        .catch(signingFailed);
    };

    /**
     * Prove who we are to one peer without sending it any content. The signed
     * hello names our peer id, not the recipient's, so one signature serves
     * every peer that joins within HELLO_REUSE_MS — a stranger joining and
     * leaving cannot make an extension-backed signer prompt on every join.
     */
    const sendHello = (peerId: string) => {
      const nowMs = Date.now();
      if (!hello || nowMs - helloAt >= HELLO_REUSE_MS) {
        helloAt = nowMs;
        hello = signEnvelope({
          room: roomId,
          peer: selfId,
          update: EMPTY_UPDATE,
          sign: (template) => signAsUser(template),
          nowSecs: Math.floor(nowMs / 1000),
        });
      }
      hello
        .then((envelope) => {
          if (disposed) return;
          signingWorked();
          sendEnvelope(envelope, [peerId]);
        })
        .catch((error: unknown) => {
          hello = null;
          helloAt = 0;
          signingFailed(error);
        });
    };

    const flushUpdates = () => {
      if (pendingUpdate.length === 0) return;
      const merged = Y.mergeUpdates(pendingUpdate);
      pendingUpdate.length = 0;
      sendSigned(merged, book.verifiedPeerIds());
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      pendingUpdate.push(update);
      if (broadcastTimer == null) {
        broadcastTimer = setTimeout(() => {
          broadcastTimer = null;
          flushUpdates();
        }, 150);
      }
    };
    doc.on("update", onDocUpdate);

    const onPeerMessage = (data: unknown, peerId: string) => {
      const activeRoom = room;
      if (!activeRoom || disposed) return;
      void receiveIntoDoc({
        doc,
        receiver,
        book,
        data,
        peerId,
        isCancelled: () => disposed,
      }).then((result) => {
        if (disposed) return;
        if (!result.accepted) {
          if (result.reason !== "cancelled") rejectedCount += 1;
          return;
        }
        if (result.newlyVerified) {
          syncCounts();
          // The peer has proved it is a member: now, and only now, hand it the
          // document so it converges.
          sendSigned(Y.encodeStateAsUpdate(doc), [peerId]);
        }
        if (!result.advanced) {
          // Already had it. Echoing here would be answered by the peer's own
          // echo, and the two peers would keep trading full-state messages for
          // as long as the room lives.
          return;
        }
        setRendered(text.toString());
        // Echo our state (throttled) so a peer that joined mid-edit converges
        // on everything we have.
        if (echoTimer == null) {
          echoTimer = setTimeout(() => {
            echoTimer = null;
            sendSigned(Y.encodeStateAsUpdate(doc), book.verifiedPeerIds());
          }, 500);
        }
      });
    };

    let receiver: ReturnType<typeof createLiveReceiver>;
    const rejectedReporter = setInterval(() => {
      if (rejectedCount !== reportedRejected) {
        reportedRejected = rejectedCount;
        setRejected(rejectedCount);
      }
    }, 2_000);

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
      const handle = openRoom(roomId);
      if (!handle) {
        setLive({ state: "unavailable", reason: "room-failed" });
        return;
      }
      room = handle;
      receiver = createLiveReceiver({ room: roomId, members: directory });
      handle.raw.onPeerJoin = (peerId) => {
        sendHello(peerId);
        syncCounts();
      };
      handle.raw.onPeerLeave = (peerId) => {
        book.leave(peerId);
        syncCounts();
      };
      handle.action.onMessage = (data, context) =>
        onPeerMessage(data, context.peerId);
      for (const peerId of Object.keys(handle.raw.getPeers())) {
        sendHello(peerId);
      }
      syncCounts();
      setLive({ state: "verified" });
    };
    void startLive().catch((error: unknown) => {
      // Unreachable in practice (each step reports its own failure); if it
      // happens the editor must not stay "connecting" forever.
      console.warn("[wiki-sync] live co-editing failed to start", error);
      if (!disposed) setLive({ state: "unavailable", reason: "room-failed" });
    });

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
      doc.off("update", onDocUpdate);
      text.unobserve(onTextChange);
      if (broadcastTimer != null) clearTimeout(broadcastTimer);
      if (echoTimer != null) clearTimeout(echoTimer);
      clearInterval(rejectedReporter);
      room?.destroy();
      doc.destroy();
      docRef.current = null;
    };
  }, [slug, initialContent, snapshotId, setRendered]);

  /**
   * Merge a page snapshot published elsewhere (another tab, or another person
   * on a relay without P2P signalling).
   *
   * Returns the merge result so callers can observe the unresolvable-overlap
   * fallback. Applied as a delta from the previous snapshot, which is what
   * makes two people editing different parts of a page converge without a P2P
   * room.
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
