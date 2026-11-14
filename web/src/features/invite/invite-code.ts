/**
 * Whether an invite link's code could be an invite at all, before anything is made or asked of the server.
 *
 * The server's codes have a fixed shape (`buzz-core` `invite.rs`): `v2.` and 43 base64url characters (a 32-byte
 * secret), or an older signed `<payload>.<mac>` whose payload says when it runs out. A link that is neither, or an
 * older one past its date, is said to be broken when the page opens, rather than after an account was made for it.
 * Whether a well-shaped code is real, used up or revoked only the server can say, when it is claimed.
 *
 * Alias-free: `invite-code.test.mjs` drives it under `node --test`.
 */

/** A canonical v2 code: 32 bytes in unpadded base64url, so the last character carries no stray bits. */
const V2_CODE = /^v2\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** Longer than any code the server accepts. */
const MAX_CODE_LENGTH = 1024;

export type InviteCodeProblem = "malformed" | "expired";

function decodeBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(
    base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="),
  );
}

/** What is wrong with `code` on its face, or null when only the server can tell. */
export function inviteCodeProblem(
  code: string,
  nowSeconds: number = Date.now() / 1000,
): InviteCodeProblem | null {
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) return "malformed";
  if (code.startsWith("v2.")) return V2_CODE.test(code) ? null : "malformed";
  const parts = code.split(".");
  if (parts.length !== 2) return "malformed";
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(parts[0] ?? ""));
    decodeBase64Url(parts[1] ?? "");
  } catch {
    return "malformed";
  }
  const fields = payload as { c?: unknown; e?: unknown } | null;
  if (
    !fields ||
    typeof fields !== "object" ||
    typeof fields.c !== "string" ||
    typeof fields.e !== "number"
  ) {
    return "malformed";
  }
  return fields.e < nowSeconds ? "expired" : null;
}
