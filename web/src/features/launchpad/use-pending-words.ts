/**
 * Work areas' words still to be published, for this project and the person signed in (`lib/pending-words.ts`): kept
 * in this browser's storage until the server accepts them, so a failed publish survives a reload or leaving the tab,
 * and a retry publishes the words alone. Every copy of the hook on the page sees the same list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  dropPending,
  keepPending,
  type PendingWords,
  pendingIn,
  pendingScope,
  type WordsStorage,
} from "./lib/pending-words";
import { workAreaUpdateContent } from "./lib/ways-to-help";
import type { Launch } from "./models";
import { usePublishMirror } from "./use-launches";

/** Said on the window when the list changes, so every copy of the hook reads it again. */
const CHANGED = "creaton:pending-words";
const changed = () => window.dispatchEvent(new Event(CHANGED));

function browserStorage(): WordsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function usePendingWords(launch: Launch | undefined) {
  const account = existingUserPubkey();
  const scope =
    launch && account
      ? pendingScope({
          relay: relayWsUrl(),
          chainId: launch.record.chainId,
          author: launch.record.author,
          launchId: launch.record.id,
          account,
        })
      : null;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const reread = () => setVersion((v) => v + 1);
    window.addEventListener(CHANGED, reread);
    window.addEventListener("storage", reread);
    return () => {
      window.removeEventListener(CHANGED, reread);
      window.removeEventListener("storage", reread);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the signal to read the storage again
  const jobs = useMemo<PendingWords[]>(() => {
    const storage = browserStorage();
    return storage && scope ? pendingIn(storage, scope) : [];
  }, [scope, version]);
  /** Keep the words until they are published. False when this browser would not keep them. */
  const keep = useCallback(
    (area: { mandate: string; id: string; check: string }) => {
      const storage = browserStorage();
      if (!storage || !scope) return false;
      const kept = keepPending(storage, {
        scope,
        ...area,
        createdAt: Math.floor(Date.now() / 1000),
      });
      changed();
      return kept;
    },
    [scope],
  );

  const publish = usePublishMirror();
  const { mutateAsync } = publish;
  /** Publish the words; forget the job once the server accepted them. Throws when it did not. */
  const send = useCallback(
    async (area: { mandate: string; id: string; check: string }) => {
      if (!launch) throw new Error("No project to publish to.");
      await mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        content: workAreaUpdateContent(area),
      });
      const storage = browserStorage();
      if (storage && scope) dropPending(storage, { scope, ...area });
      changed();
    },
    [launch, mutateAsync, scope],
  );

  return { jobs, keep, send, busy: publish.isPending };
}
