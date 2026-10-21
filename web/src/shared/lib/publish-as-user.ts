import { signAsUser } from "@/shared/lib/identity";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { openPublishSession, publishEvent } from "@/shared/lib/publish-event";
import { refusalText } from "@/shared/lib/refusal-text";
import { relayWsUrl } from "@/shared/lib/relay-url";

/**
 * Sign `template` as the person using the app, publish it to the server, and
 * throw when the server refuses it: the server's own reason if it gave one,
 * otherwise `failure`. Returns the signed event so a caller that needs its id
 * or signer does not sign twice.
 */
export async function publishAsUser(
  template: Parameters<typeof signAsUser>[0],
  failure: string,
): Promise<SignedNostrEvent> {
  const signed = await signAsUser(template);
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) throw new Error(refusalText(result.message, failure));
  return signed;
}

/** A connection for signing and sending several records as the user in a row. */
export interface UserPublisher {
  /** Sign `template` as the user, send it, and throw when the server refuses it. */
  publish: (
    template: Parameters<typeof signAsUser>[0],
    failure: string,
  ) => Promise<SignedNostrEvent>;
  close: () => void;
}

/**
 * {@link publishAsUser} for a run of records: one connection, one login, each
 * record sent and answered before the next. Close it when done.
 */
export function openUserPublisher(): UserPublisher {
  const session = openPublishSession(relayWsUrl(), { signAuth: signAsUser });
  return {
    publish: async (template, failure) => {
      const signed = await signAsUser(template);
      const result = await session.publish(signed);
      if (!result.accepted)
        throw new Error(refusalText(result.message, failure));
      return signed;
    },
    close: session.close,
  };
}
