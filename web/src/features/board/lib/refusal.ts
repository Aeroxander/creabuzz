/**
 * The server says why it refused a write as `reason: words` (`rate-limited: you can start 5 boards a day; …`). People
 * see the words as a sentence, without the machine prefix, whatever the reason.
 *
 * Alias-free; `refusal.test.mjs` drives it under `node --test`.
 */
import { asSentence } from "../../../shared/lib/refusal-text.ts";

export function plainRefusal(message: string): string {
  const text = message.replace(/^[a-z-]+:\s*/, "").trim();
  return text === ""
    ? "The server didn't accept that. Try again."
    : asSentence(text);
}
