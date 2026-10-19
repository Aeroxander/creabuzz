/**
 * The server says why it refused a write as `reason: words` (`rate-limited: you can start 5 boards a day; …`). People
 * see the words as a sentence, without the machine prefix.
 *
 * Alias-free; `refusal.test.mjs` drives it under `node --test`.
 */
export function plainRefusal(message: string): string {
  const text = message.replace(/^[a-z-]+:\s*/, "").trim();
  if (text === "") return "The server didn't accept that. Try again.";
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
