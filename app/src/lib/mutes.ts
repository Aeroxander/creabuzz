/**
 * The people this account hides, for themselves only: the private mute list (kind 10000, the one `web/` and other clients
 * read too), opened and written through `@creaton/core/social/mute/mute-list.ts`. Nothing is sent to anyone: the list is
 * sealed to the account's own key, so the person who is hidden never learns of it.
 *
 * A list that was saved by another app in a form this one cannot read is never overwritten: hiding then says so and
 * changes nothing. A list that cannot be opened right now (a locked passkey, a refused signer) keeps the last set that was
 * read, and never shows a person as un-hidden because of it.
 */
import {
  nip44DecryptAsUser,
  nip44EncryptAsUser,
} from "@creaton/core/client/identity.ts";
import { KIND_MUTE_LIST } from "@creaton/core/kinds.ts";
import {
  type MuteState,
  mutedInState,
  nextMuteList,
  readMuteState,
} from "@creaton/core/social/mute/mute-list.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAccount } from "./account";
import { publishAsUser, readLatest } from "./relay";

const NOBODY: ReadonlySet<string> = new Set();

const muteKeys = {
  mine: (me: string | null) => ["mutes", me] as const,
};

/** The newest mute list of `me`, opened. Rejects when it cannot be opened, which is not "nobody is hidden". */
async function readState(me: string): Promise<MuteState> {
  const list = await readLatest(KIND_MUTE_LIST, me);
  return readMuteState(list, (ciphertext) =>
    nip44DecryptAsUser(me, ciphertext),
  );
}

/** Who this account hides, and the two presses: hide and show again. Empty for someone without an account. */
export function useMutes() {
  const { pubkey } = useAccount();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: muteKeys.mine(pubkey),
    enabled: pubkey !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: () => readState(pubkey as string),
  });
  const change = useMutation({
    mutationFn: async (input: { pubkey: string; muted: boolean }) => {
      const me = pubkey as string;
      // Read afresh first: a change made on another device is not lost.
      const fresh = await readState(me);
      const template = await nextMuteList(
        fresh,
        input.pubkey,
        input.muted,
        (plaintext) => nip44EncryptAsUser(me, plaintext),
      );
      await publishAsUser(template, "That was not saved. Try again.");
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: muteKeys.mine(pubkey) }),
  });
  // One set until the list changes, so what is built from it (a filtered list of posts) is not rebuilt on every draw.
  const muted = useMemo(
    () => (state.data ? mutedInState(state.data) : NOBODY),
    [state.data],
  );
  const setMuted = useCallback(
    (target: string, hidden: boolean) =>
      change.mutateAsync({ pubkey: target, muted: hidden }),
    [change],
  );
  return {
    /** The hidden people (lower-case keys). */
    muted,
    /** Whether the list was read (or there is none): until then nobody can be told "you hid them". */
    ready: state.isSuccess,
    /** The list could not be opened (a locked passkey, a refused signer): whoever was hidden may show until it can. */
    failed: state.isError,
    /** The list was saved by another app in a form this one cannot read. */
    readable: state.data?.readable ?? true,
    hide: (target: string) => setMuted(target, true),
    showAgain: (target: string) => setMuted(target, false),
    pending: change.isPending,
  };
}
