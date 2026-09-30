/**
 * OS-facing deep links that hand off from the browser to the Creaton desktop app.
 *
 * The desktop build registers the `creaton` URL scheme (see
 * `desktop/src-tauri/tauri.conf.json` and `build_identity::deep_link_scheme` in
 * `desktop/src-tauri/src/build_identity.rs`). Every link a user can click
 * outside the app — "Open in Creaton", invite landing pages — must use that
 * scheme. The upstream `buzz` scheme is owned by the original Buzz app when
 * both are installed, so a `buzz://` handoff would open the wrong app.
 *
 * `buzz://` remains the canonical in-app link format (message and entity links
 * inside chat content); only the browser→desktop handoff uses `creaton://`.
 */
const DESKTOP_DEEP_LINK_SCHEME = "creaton";

/** `creaton://connect?relay=<ws(s)://...>` — connects the desktop app to a relay. */
export function desktopConnectDeepLink(relayWsUrl: string): string {
  return `${DESKTOP_DEEP_LINK_SCHEME}://connect?relay=${encodeURIComponent(relayWsUrl)}`;
}

/**
 * `creaton://join?relay=<ws(s)://...>&code=<invite>[&policy_receipt=<receipt>]`
 * — claims an invite against a relay from the desktop app.
 */
export function desktopJoinDeepLink({
  relay,
  code,
  policyReceipt,
}: {
  relay: string;
  code: string;
  policyReceipt?: string | null;
}): string {
  const query = new URLSearchParams({ relay, code });
  if (policyReceipt) query.set("policy_receipt", policyReceipt);
  return `${DESKTOP_DEEP_LINK_SCHEME}://join?${query.toString()}`;
}
