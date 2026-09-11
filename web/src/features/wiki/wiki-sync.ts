/**
 * Live multi-user wiki editing: Yjs documents synced peer-to-peer over
 * Trystero (WebRTC with the community relay as Nostr signaling only) and
 * snapshotted to the relay (kind:44001) on save.
 *
 * Protocol (y-webrtc-style): connect → announce → when a new peer joins,
 * send the full state vector delta; live edits broadcast as throttled Yjs
 * update deltas; every received update echoes our state back (throttled)
 * so late joiners fully converge. The relay stays the durable source of
 * truth via explicit saves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { joinRoom } from "trystero/nostr";

import { relayWsUrl } from "@/shared/lib/relay-url";

import { applyPeerUpdate } from "./lib/sync-loop";
import { commitLocalEdit, type CommitResult } from "./lib/text-edit";

const APP_ID = "buzz-wiki";

interface WikiAction {
  onMessage: ((data: unknown) => void) | null;
  send: (data: unknown) => void;
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

function openRoom(slug: string): RoomHandle | null {
  try {
    const room = joinRoom(
      { appId: APP_ID, relayConfig: { urls: [relayWsUrl()] } },
      `wiki:${slug}`,
    );
    return {
      action: room.makeAction("updates") as WikiAction,
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

function toUint8(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as Uint8Array;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
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
  /** Live editing peers connected through the P2P room (0 when alone). */
  peers: number;
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
   * Connected editing peers, excluding this tab.
   *
   * Peer-to-peer editing needs the relay to accept the trystero signalling
   * events (`BUZZ_P2P_SIGNALING`), so "editing alone" is the honest state on a
   * relay that has not enabled them — and without surfacing it the feature
   * looks broken rather than unavailable.
   */
  const [peers, setPeers] = useState(0);
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
    if (text.toString().length === 0 && initialContent.length > 0) {
      doc.transact(() => {
        text.insert(0, initialContent);
      }, doc.clientID);
    }

    const room = openRoom(slug);
    let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    let echoTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingUpdate: Uint8Array[] = [];

    const sendBuffer = (bytes: Uint8Array) => {
      room?.action.send(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    };

    const flushUpdates = () => {
      if (pendingUpdate.length === 0) return;
      const merged = Y.mergeUpdates(pendingUpdate);
      pendingUpdate.length = 0;
      sendBuffer(merged);
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

    if (room) {
      const syncPeerCount = () =>
        setPeers(Object.keys(room.raw.getPeers()).length);
      room.raw.onPeerJoin = () => {
        // A new peer only has its own doc; hand ours over so it converges.
        sendBuffer(Y.encodeStateAsUpdate(doc));
        syncPeerCount();
      };
      room.raw.onPeerLeave = syncPeerCount;
      syncPeerCount();
      room.action.onMessage = (data) => {
        const bytes = toUint8(data);
        if (!bytes) return;
        let advanced = false;
        try {
          advanced = applyPeerUpdate(doc, bytes);
        } catch (error) {
          console.warn("[wiki-sync] apply failed", error);
          return;
        }
        if (!advanced) {
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
            sendBuffer(Y.encodeStateAsUpdate(doc));
          }, 500);
        }
      };
    }

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
      doc.off("update", onDocUpdate);
      text.unobserve(onTextChange);
      if (broadcastTimer != null) clearTimeout(broadcastTimer);
      if (echoTimer != null) clearTimeout(echoTimer);
      room?.destroy();
      doc.destroy();
      docRef.current = null;
    };
  }, [slug, initialContent, setRendered]);

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

  return { content, setContent, mergeRemoteSnapshot, touched, peers };
}
