/**
 * The two calls that keep this device's alerts at the server (plan section 6.3): `PUT /push/web` saves the device's
 * subscription, `DELETE /push/web` removes it. Each is signed by the person's own key for that one request (NIP-98), so the
 * server knows whose device it is. A subscription is a bearer address for this device: it goes only here, and is never
 * published, logged or shown.
 */
import { makeNip98AuthHeader } from "@creaton/core/client/nip98.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import { timedFetchStreamed } from "@creaton/core/client/timed-fetch.ts";

const PATH = "/push/web";

/** A call the server did not accept. Carries only the status: the words people read are the card's own. */
export class PushCallError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The server answered ${status}.`);
    this.name = "PushCallError";
    this.status = status;
  }
}

async function call(method: "PUT" | "DELETE", body: string): Promise<void> {
  const url = `${relayHttpBaseUrl()}${PATH}`;
  const auth = await makeNip98AuthHeader(url, method, { body });
  const response = await timedFetchStreamed(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: auth },
    body,
    timeoutMs: 15_000,
  });
  if (!response.ok) throw new PushCallError(response.status);
}

/** What a browser's `PushSubscription.toJSON()` gives. */
interface SubscriptionJson {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/** Save this device for the signed-in account. Throws when the server does not accept it. */
export async function saveDevice(json: SubscriptionJson): Promise<void> {
  const { endpoint, keys } = json;
  if (!endpoint || !keys?.p256dh || !keys.auth)
    throw new Error("The device gave no subscription.");
  await call(
    "PUT",
    JSON.stringify({
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    }),
  );
}

/** Ask the server to forget the device at `endpoint`. Throws when it does not. */
export async function forgetDevice(endpoint: string): Promise<void> {
  await call("DELETE", JSON.stringify({ endpoint }));
}
