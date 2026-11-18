/**
 * What a founder reads when approving or declining a join request did not go through (ProjectDetailPage). A refusal the
 * server explained (already in plain words by `refusalText`) is shown as it is; the generic refusal the publish path
 * falls back to, or a failure with no message, becomes what happened to this request and which button to press. Pure,
 * so `request-answer-copy.test.mjs` pins it.
 */

/**
 * The Projects board publish path's fallback when the server refused without a reason (use-projects.ts
 * `publishTemplate`, so the join dialog shows it as it is). Exported so {@link requestAnswerError} recognizes it.
 */
export const GENERIC_REFUSAL =
  "The server didn't save this, so nothing changed. Check your connection, then try again.";

export function requestAnswerError(
  action: "approve" | "decline",
  err: unknown,
): string {
  const message = err instanceof Error ? err.message.trim() : "";
  if (message && message !== GENERIC_REFUSAL) return message;
  const what = action === "approve" ? "approval" : "decline";
  const button = action === "approve" ? "Approve" : "Decline";
  return `The server didn't save your ${what}, so nothing changed for this request. Press ${button} to try again.`;
}
