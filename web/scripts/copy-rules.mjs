/**
 * The web app's own plain-copy rules, checked with the shared ones (`scripts/check-copy-core.mjs`).
 *
 * The desktop app keeps an advanced key screen where these words belong, so they are not shared rules.
 */

/** @type {readonly import("../../scripts/check-copy-core.mjs").CopyRule[]} */
export const WEB_COPY_RULES = [
  {
    id: "key-format",
    // A sentence or label that names the key format ("Public key or npub"). A bare "npub" (a format name in code) or a
    // test id ("link-device-npub") has no space in it and is not text anyone reads.
    pattern: /^(?=[\s\S]*\s)[\s\S]*\bnpub/i,
    why: 'say "public key" or let people search by name; key formats belong in a "Technical details" section',
  },
];
