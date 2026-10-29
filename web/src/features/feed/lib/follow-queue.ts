/**
 * One path for every change to the reader's follow lists (the contact list, kind 3, and the launch bookmarks, kind
 * 10003). Both lists replace themselves on every write, so two changes built from the same copy lose one of them:
 * following two people quickly used to keep only the second. Here changes run one at a time; each re-reads the newest
 * list from the server (or the one this tab last wrote, if that is newer), applies only its own change, and is dated
 * strictly after the list it replaces. A failed read or write rejects that change and leaves the list as it was.
 *
 * Pure and alias-free: `follow-queue.test.mjs` drives it under `node --test`.
 */

import type { EventTemplate, SignedEventLike } from "./feed-events.ts";

/** Changes waiting at once; more than this is refused rather than queued without end. */
export const MAX_QUEUED_LIST_WRITES = 50;

export interface ListWrite {
  /** Whose list on which server, e.g. `${relay}|${pubkey}`: lists never mix across people or communities. */
  scope: string;
  /** Whose list it is. */
  author: string;
  kind: number;
  /** What the change is about (a person's key, a launch coordinate): the pending state is shown per target. */
  target: string;
  /** The state the change asks for, shown while it waits. */
  follow: boolean;
  /** The list after this one change, from the newest list (null when there is none yet). */
  apply: (latest: SignedEventLike | null) => EventTemplate;
  /** Runs with the written list before the change stops showing as pending, so the button never flickers back. */
  onWritten?: (written: SignedEventLike) => void;
}

export interface ListWriterDeps {
  /** The newest list of the write's kind by its author on the server, or null. Throws when the server cannot be read. */
  readLatest: (write: ListWrite) => Promise<SignedEventLike | null>;
  /** Sign and send; throws when the server refuses. */
  publish: (template: EventTemplate) => Promise<SignedEventLike>;
  /** Unix seconds. */
  now?: () => number;
}

export interface ListWriter {
  enqueue: (write: ListWrite) => Promise<SignedEventLike>;
  /** The state a target is waiting for, or undefined when nothing is waiting for it. */
  pendingFor: (
    scope: string,
    kind: number,
    target: string,
  ) => boolean | undefined;
  /** The newer of `list` and the list this tab last wrote for the scope and kind. */
  newest: (
    scope: string,
    kind: number,
    list: SignedEventLike | null,
  ) => SignedEventLike | null;
  subscribe: (listener: () => void) => () => void;
  /** A value that changes whenever the pending state does (for `useSyncExternalStore`). */
  version: () => number;
}

/** True when `a` replaces `b`: later, or the same second with the larger id (how replaceable events are settled). */
function isNewer(a: SignedEventLike, b: SignedEventLike | null): boolean {
  if (!b) return true;
  return (
    a.created_at > b.created_at ||
    (a.created_at === b.created_at && a.id > b.id)
  );
}

export function createListWriter(deps: ListWriterDeps): ListWriter {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const written = new Map<string, SignedEventLike>();
  const pending = new Map<string, { follow: boolean; count: number }>();
  const listeners = new Set<() => void>();
  let queued = 0;
  let version = 0;
  // The tail of the chain never rejects, so one failed change does not stop the ones after it.
  let tail: Promise<unknown> = Promise.resolve();

  const listKey = (scope: string, kind: number) => `${scope}|${kind}`;
  const targetKey = (scope: string, kind: number, target: string) =>
    `${scope}|${kind}|${target}`;
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const newest = (
    scope: string,
    kind: number,
    list: SignedEventLike | null,
  ): SignedEventLike | null => {
    const mine = written.get(listKey(scope, kind)) ?? null;
    if (!mine) return list;
    return list && isNewer(list, mine) ? list : mine;
  };

  async function run(write: ListWrite): Promise<SignedEventLike> {
    const base = newest(write.scope, write.kind, await deps.readLatest(write));
    const template = write.apply(base);
    const signed = await deps.publish({
      ...template,
      created_at: Math.max(
        template.created_at ?? 0,
        now(),
        (base?.created_at ?? 0) + 1,
      ),
    });
    const key = listKey(write.scope, write.kind);
    if (isNewer(signed, written.get(key) ?? null)) written.set(key, signed);
    write.onWritten?.(signed);
    return signed;
  }

  return {
    enqueue(write) {
      if (queued >= MAX_QUEUED_LIST_WRITES) {
        return Promise.reject(
          new Error(
            "Too many follow changes are waiting. Try again in a moment.",
          ),
        );
      }
      queued += 1;
      const key = targetKey(write.scope, write.kind, write.target);
      const entry = pending.get(key);
      pending.set(key, {
        follow: write.follow,
        count: (entry?.count ?? 0) + 1,
      });
      changed();
      const done = tail.then(() => run(write));
      const settle = () => {
        queued -= 1;
        const current = pending.get(key);
        if (current && current.count > 1) {
          pending.set(key, { ...current, count: current.count - 1 });
        } else {
          pending.delete(key);
        }
        changed();
      };
      tail = done.then(settle, settle);
      return done;
    },
    pendingFor(scope, kind, target) {
      return pending.get(targetKey(scope, kind, target))?.follow;
    },
    newest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}
