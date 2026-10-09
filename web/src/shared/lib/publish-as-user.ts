import { signAsUser } from "@/shared/lib/identity";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { publishEvent } from "@/shared/lib/publish-event";
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
  if (!result.accepted) throw new Error(result.message || failure);
  return signed;
}
