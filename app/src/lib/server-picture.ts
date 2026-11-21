/**
 * Whether an address is a picture kept on this community's own server: the only kind a post draws (a post never makes the phone
 * ask another website for a picture). Small on purpose: reading posts needs this, and the picture fetching (`./server-media`)
 * loads only when a post with a picture is on screen.
 */
import { serverMediaUrl } from "@creaton/core/client/media-url.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";

export function isServerPicture(url: string): boolean {
  try {
    return serverMediaUrl(url, relayHttpBaseUrl()) !== null;
  } catch {
    return false;
  }
}
