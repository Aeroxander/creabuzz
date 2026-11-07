/**
 * The person someone pasted to appoint as a moderator: their profile link (`…/u/<key>`) or their key, as the board's
 * people form takes it. Null when it is neither.
 *
 * Alias-free; `person-link.test.mjs` drives it under `node --test`.
 */

import { parsePersonInput } from "./members.ts";

export function parsePersonOrLink(text: string): string | null {
  const value = text.trim();
  const direct = parsePersonInput(value);
  if (direct !== null) return direct;
  const match = /(?:^|\/)u\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(value);
  if (!match) return null;
  try {
    return parsePersonInput(decodeURIComponent(match[1]));
  } catch {
    // A malformed escape is not a key.
    return null;
  }
}
