/**
 * A passkey that did not work, in words: the browser's own message is often a sentence about "the operation".
 *
 * Alias-free and import-free: `passkey-problem.test.mjs` drives it under `node --test`.
 */

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
}

/** Making an account with a passkey failed. `instead` is the other way to make one, as the screen offers it. */
export function passkeyCreateProblem(
  error: unknown,
  instead = "create without a passkey",
): string {
  const name = errorName(error);
  if (name === "NotAllowedError" || name === "AbortError") {
    return `The passkey was cancelled. Try again, or ${instead}.`;
  }
  if (name === "PrfUnavailableError") {
    return `This browser cannot keep a passkey account. ${capitalize(instead)} instead.`;
  }
  return `The passkey did not work in this browser. Try again, or ${instead}.`;
}

/** Unlocking the passkey this browser already has failed. */
export function passkeyUnlockProblem(error: unknown): string {
  const name = errorName(error);
  if (name === "NotAllowedError" || name === "AbortError") {
    return "The passkey was cancelled. Try again when you're ready.";
  }
  if (
    error instanceof Error &&
    /re-derived a different Nostr identity/.test(error.message)
  ) {
    return "That passkey belongs to a different account. Choose the passkey you made in this browser.";
  }
  return "Your passkey did not unlock. Try again.";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
