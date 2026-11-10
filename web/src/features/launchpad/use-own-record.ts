import { useCallback } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

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
 *
 * `change` gets the record as the server has it and answers the fields to set; answering null means there is nothing
 * to do (the record already says so), and nothing is sent.
 */
export function useChangeOwnRecord() {
  const save = useCreateLaunch();
  const { mutateAsync } = save;
  return useCallback(
    async (
      launchId: string,
      change: (record: LaunchRecord) => Partial<CreateLaunchInput> | null,
    ): Promise<LaunchRecord> => {
      const me = existingUserPubkey();
      if (me === null) throw new Error("Sign in to change your project.");
      const own = await fetchOwnRecord(me, launchId);
      if (!own) throw new Error(OWN_RECORD_GONE);
      const fields = change(own);
      if (fields === null) return own;
      await mutateAsync(
        recordToInput(own, {
          // A project with no chain keeps none: the default below is for the sale editor only.
          chainId: own.chainId ?? "",
          supersedes: own.createdAt,
          ...fields,
        }),
      );
      return own;
    },
    [mutateAsync],
  );
}
