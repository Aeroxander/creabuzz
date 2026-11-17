/**
 * The app's own plain-copy rules, checked with the shared ones (`scripts/check-copy-core.mjs`): the same key-format
 * rule as web/, and the product name only from the brand constant.
 */

/** @type {readonly import("../../scripts/check-copy-core.mjs").CopyRule[]} */
export const APP_COPY_RULES = [
  {
    id: "key-format",
    pattern: /^(?=[\s\S]*\s)[\s\S]*\bnpub/i,
    why: 'say "public key" or let people search by name; key formats belong in a "Technical details" section',
  },
  {
    id: "old-product-name",
    pattern: /\bBuzz\b/,
    why: "the name people see is Creaton, from APP_NAME in @creaton/core/brand.ts",
  },
];
