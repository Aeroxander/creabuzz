/**
 * Relay rejection text -> a sentence that says what happened and what to do
 * next. The relay's bodies are deliberately generic (a caller must not probe
 * which hosts are mapped), so the actionable half is a CLIENT concern: the
 * app knows its own address and its own dev workflows.
 */
export function friendlyRelayError(detail: string): string {
  if (detail.includes("no community is configured for this host")) {
    return "This server has no community at this address yet. If you are testing locally, run `just dev-community` in the project, then reload.";
  }
  return detail;
}
