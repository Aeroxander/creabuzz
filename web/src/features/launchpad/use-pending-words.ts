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
  type KeepResult,
  keepPending,
  type PendingWords,
  pendingFull,
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

/** A token for one payload of words, so only its own publish acknowledges it. */
function revisionToken(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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
  const { jobs, full } = useMemo(() => {
    const storage = browserStorage();
    return {
      jobs: storage && scope ? pendingIn(storage, scope) : [],
      // At its bound across every project in this browser: a new work area's words could not be kept.
      full: storage ? pendingFull(storage) : false,
    };
  }, [scope, version]);
  /**
   * Keep the words until they are published, under a revision of their own. The job comes back either way, so the
   * caller can still try to publish it; `result` says whether this browser kept it.
   */
  const keep = useCallback(
    (area: {
      mandate: string;
      id: string;
      check: string;
    }): { job: PendingWords; result: KeepResult } => {
      const job: PendingWords = {
        scope: scope ?? "",
        ...area,
        createdAt: Math.floor(Date.now() / 1000),
        revision: revisionToken(),
      };
      const storage = browserStorage();
      if (!storage || !scope) return { job, result: "unavailable" };
      const result = keepPending(storage, job);
      changed();
      return { job, result };
    },
    [scope],
  );

  const publish = usePublishMirror();
  const { mutateAsync } = publish;
  /**
   * Publish the words; once the server accepted them, forget that job's revision only (newer words that replaced it
   * stay to be published). Throws when the server did not accept them.
   */
  const send = useCallback(
    async (job: PendingWords) => {
      if (!launch) throw new Error("No project to publish to.");
      await mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        content: workAreaUpdateContent(job),
      });
      const storage = browserStorage();
      if (storage && scope) dropPending(storage, { ...job, scope });
      changed();
    },
    [launch, mutateAsync, scope],
  );

  return { jobs, full, keep, send, busy: publish.isPending };
}
