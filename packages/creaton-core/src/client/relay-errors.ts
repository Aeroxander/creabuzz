/**
 * Relay rejection text -> a sentence that says what happened and what to do
 * next. The relay's bodies are deliberately generic (a caller must not probe
 * which hosts are mapped), so the actionable half is a CLIENT concern: the
 * app knows its own address. The developer's command for a local setup is
 * shown only in a development build, never to people using the app.
 */
export function friendlyRelayError(detail: string): string {
  if (detail.includes("no community is configured for this host")) {
    const plain =
      "This server has no community at this address yet. Check the address, or try again later.";
    return import.meta.env?.DEV
      ? `${plain} (Testing locally? Run \`just dev-community\` in the project, then reload.)`
      : plain;
  }
  return detail;
}
