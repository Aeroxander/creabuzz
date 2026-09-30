/**
 * Shared with the desktop app: the pure royalty statement model (selectors,
 * word decoders, statement math) lives in `@creaton/core/launchpad/royalty.ts`.
 * The golden vectors in `royalty.test.mjs` bind the shared implementation
 * through this re-export.
 *
 * Intentionally divergent twins stay per app: the UI-facing wrappers
 * (`ui/RoyaltyStatementCard.tsx` and its read/send hooks) keep each app's own
 * chain seam (`chain.ts` ethCall + `SenderPicker` here) and are not unified.
 */
export * from "@creaton/core/launchpad/royalty.ts";
