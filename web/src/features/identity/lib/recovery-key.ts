/**
 * A recovery key as a person pastes it: the 64 characters this app shows when saving one, or the `nsec1…` form other
 * apps use. Spaces, line breaks and a surrounding quote from copying are ignored. Returns the key as 64 lower-case hex
 * characters, or null when it is not a key.
 */
import { decode } from "nostr-tools/nip19";

export function parseRecoveryKey(input: string): string | null {
  const text = input.replace(/[\s"'`]/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  if (!text.toLowerCase().startsWith("nsec1")) return null;
  try {
    const decoded = decode(text.toLowerCase());
    if (decoded.type !== "nsec") return null;
    return Array.from(decoded.data, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return null;
  }
}
