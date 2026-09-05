/**
 * Live multi-user wiki editing: Yjs documents synced peer-to-peer over
 * Trystero (WebRTC with the community relay as Nostr signaling only) and
 * snapshotted to the relay (kind:44001) on save.
 *
 * Three tabs/people editing one page converge in real time with zero relay
 * payload; the relay stays the durable source of truth via save.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { joinRoom } from "trystero/nostr";

import { relayWsUrl } from "@/shared/lib/relay-url";

const APP_ID = "buzz-wiki";

interface WikiAction {
  onMessage: ((data: unknown) => void) | null;
  send: (data: unknown) => void;
}

interface RoomHandle {
  action: WikiAction;
  destroy: () => void;
}

function openRoom(slug: string): RoomHandle | null {
  try {
    const room = joinRoom(
      { appId: APP_ID, relayConfig: { urls: [relayWsUrl()] } },
      `wiki:${slug}`,
    );
    const action = room.makeAction("updates") as WikiAction;
    return {
      action,
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
 */
export function useLiveWikiDoc(
  slug: string | null,
  initialContent: string,
): { content: string; setContent: (value: string) => void } {
  const docRef = useRef<Y.Doc | null>(null);
  const textRef = useRef<Y.Text | null>(null);
  const [content, setContentState] = useState(initialContent);

  useEffect(() => {
    if (!slug) return;
    const doc = new Y.Doc();
    docRef.current = doc;
    const text = doc.getText("content");
    textRef.current = text;
    if (text.toString().length === 0 && initialContent.length > 0) {
      doc.transact(() => {
        text.insert(0, initialContent);
      }, doc.clientID);
    }

    const room = openRoom(slug);
    let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingUpdate: Uint8Array[] = [];

    const flush = () => {
      if (pendingUpdate.length === 0) return;
      const merged = Y.mergeUpdates(pendingUpdate);
      pendingUpdate.length = 0;
      room?.action.send(
        merged.buffer.slice(
          merged.byteOffset,
          merged.byteOffset + merged.byteLength,
        ),
      );
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      pendingUpdate.push(update);
      if (broadcastTimer == null) {
        broadcastTimer = setTimeout(() => {
          broadcastTimer = null;
          flush();
        }, 150);
      }
    };
    doc.on("update", onDocUpdate);

    if (room) {
      let echoTimer: ReturnType<typeof setTimeout> | null = null;
      room.action.onMessage = (data) => {
        const bytes = toUint8(data);
        if (!bytes) return;
        try {
          Y.applyUpdate(doc, bytes, "remote");
        } catch (error) {
          console.warn("[wiki-sync] apply failed", error);
        }
        setContentState(text.toString());
        // Echo our current state (throttled): a peer that joined after us
        // may only have its own snapshot, and Yjs needs both to converge.
        if (echoTimer == null) {
          echoTimer = setTimeout(() => {
            echoTimer = null;
            room.action.send(Y.encodeStateAsUpdate(doc).buffer);
          }, 500);
        }
      };
      // Send our current state so peers that were already in the room
      // converge, and any peer joining later receives ours via their request.
      room.action.send(Y.encodeStateAsUpdate(doc).buffer);
    }

    const onTextChange = () => setContentState(text.toString());
    text.observe(onTextChange);
    setContentState(text.toString());

    return () => {
      doc.off("update", onDocUpdate);
      text.unobserve(onTextChange);
      if (broadcastTimer != null) {
        clearTimeout(broadcastTimer);
      }
      room?.destroy();
      doc.destroy();
      docRef.current = null;
    };
  }, [slug, initialContent]);

  const setContent = useCallback((value: string) => {
    const doc = docRef.current;
    const text = textRef.current;
    if (!doc || !text) return;
    doc.transact(() => {
      const current = text.toString();
      if (current === value) return;
      text.delete(0, current.length);
      if (value.length > 0) text.insert(0, value);
    }, "local");
    setContentState(value);
  }, []);

  return { content, setContent };
}
