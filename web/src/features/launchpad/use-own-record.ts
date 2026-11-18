import { useCallback } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

import { relayWsUrl } from "@/shared/lib/relay-url";

import { inTurn, readFresh } from "./lib/own-record-queue";
import { recordToInput } from "./lib/record-input";
import type { LaunchRecord } from "./models";
import {
  type CreateLaunchInput,
  fetchOwnRecord,
  useCreateLaunch,
} from "./use-launches";

/** Said when the founder's record is no longer on the server, so there is nothing to change. */
const OWN_RECORD_GONE =
  "This project's record is not on the server any more, so it can't be changed.";

/**
 * Change one thing on the signed-in founder's own project record.
 *
 * The record is read from the server first (never a remembered copy: another tab or device may have changed it), the
 * change is merged over everything it holds, and it is published once, signed later than the one it replaces. Sending
 * the same change again after a lost answer publishes the same record again, which replaces itself: nothing doubles.
 * Changes to one record take turns, so two pressed close together both land.
 *
 * `change` gets the record as the server has it and answers the fields to set; answering null means there is nothing
 * to do (the record already says so), and nothing is sent.
 */
/** What a change did. */
export interface OwnRecordChange {
  /** The record as the server had it before the change. */
  before: LaunchRecord;
  /**
   * When the record that now carries the change was signed: the one just published, or, when the record already said
   * so and nothing was sent, the one that was read.
   */
  signedAt: number;
}

/** When this tab last saved each record (by server, founder and project): the next change must read at least that. */
const lastSaved = new Map<string, number>();

export function useChangeOwnRecord() {
  const save = useCreateLaunch();
  const { mutateAsync } = save;
  return useCallback(
    (
      launchId: string,
      change: (
        record: LaunchRecord,
      ) =>
        | Partial<CreateLaunchInput>
        | null
        | Promise<Partial<CreateLaunchInput> | null>,
    ): Promise<OwnRecordChange> => {
      const me = existingUserPubkey();
      if (me === null)
        return Promise.reject(new Error("Sign in to change your project."));
      const key = `${relayWsUrl()}|${me}:${launchId}`;
      // One change at a time per record, from whatever part of the page: each reads only once the one before it has
      // finished, so none publishes over another (`lib/own-record-queue.ts`).
      return inTurn(key, async () => {
        const own = await readFresh(
          () => fetchOwnRecord(me, launchId),
          lastSaved.get(key),
        );
        if (!own) throw new Error(OWN_RECORD_GONE);
        const fields = await change(own);
        if (fields === null) return { before: own, signedAt: own.createdAt };
        const signed = await mutateAsync(
          recordToInput(own, {
            // A project with no chain keeps none: the default below is for the sale editor only.
            chainId: own.chainId ?? "",
            supersedes: own.createdAt,
            ...fields,
          }),
        );
        lastSaved.set(key, signed.created_at);
        return { before: own, signedAt: signed.created_at };
      });
    },
    [mutateAsync],
  );
}
