/**
 * The shape of a kind:47005 receipt, in one place.
 *
 * Every receipt mirror carries exactly one `tx` tag holding the settlement tx
 * hash. That is not decoration: the relay refuses a receipt envelope without a
 * well-formed `tx` tag (`crates/buzz-relay/src/handlers/ingest.rs`,
 * `validate_launch_mirror_envelope`), and `parseLaunchReceipt` drops a receipt
 * without one — so a claim or verdict mirrored without it was rejected by a
 * real relay *and* invisible on the feed, while the e2e suite stayed green
 * because the mock relay does not validate. Building the tags and the content
 * here keeps both clients from drifting off the relay again.
 */

/** A receipt tag. Kept plain so this module is `node --test` importable. */
export type ReceiptTag = [string, string];

/** Settlement tx hash, exactly as the relay validates it. */
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Evidence hash: 64 hex chars, no `0x` (a sha256 of the canonical claim). */
export const EVIDENCE_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function isTxHash(value: string): boolean {
  return TX_HASH_RE.test(value.trim());
}

/** The one wording the field and the handlers use for a bad tx hash. */
export const TX_HASH_HINT =
  "Settlement tx hash must be 0x followed by 64 hex characters.";

/** Tags + content of a milestone claim mirror (47005, `kind=claim`). */
export function claimReceiptParts(input: {
  claimId: string;
  evidenceHash: string;
  tx: string;
}): { extraTags: ReceiptTag[]; content: Record<string, string> } {
  return {
    extraTags: [
      ["kind", "claim"],
      ["claim", input.claimId],
      ["evidence", input.evidenceHash],
      ["tx", input.tx],
    ],
    content: {
      table: "claim",
      claim: input.claimId,
      evidenceHash: input.evidenceHash,
    },
  };
}

/**
 * Tags + content of a verifier verdict mirror (47005, `kind=verdict`).
 *
 * The content carries the verdict *word*, not a boolean: NIP-LP fixes the
 * vocabulary at `approve|reject` so a reader never has to guess which spelling
 * of "no" this client meant.
 */
export function verdictReceiptParts(input: {
  claimId: string;
  verdict: "approve" | "reject";
  tx: string;
}): { extraTags: ReceiptTag[]; content: Record<string, string> } {
  return {
    extraTags: [
      ["kind", "verdict"],
      ["claim", input.claimId],
      ["tx", input.tx],
    ],
    content: {
      table: "verdict",
      claim: input.claimId,
      verdict: input.verdict,
    },
  };
}
