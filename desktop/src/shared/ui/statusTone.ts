/**
 * Semantic status tier mapping (docs/paperclip-ux-reference.md §5).
 *
 * Pure data on purpose: `StatusBadge` / `StatusGlyph` consume it, and the
 * variant→palette contract is unit-tested (`statusBadgeMapping.test.mjs`)
 * without mounting React. Every class routes through the `status-*` Tailwind
 * tokens — no hardcoded status colors (P0 cross-cutting rule).
 */

/** One hue per meaning. Blue=liveness, amber=waiting, red=blocking, green=ok,
 *  violet=in-review, gray=neutral. */
export type StatusTone =
  | "live"
  | "waiting"
  | "blocking"
  | "ok"
  | "review"
  | "neutral";

export type StatusBadgeVariant =
  | "pending"
  | "resolving"
  | "approved"
  | "denied"
  | "review"
  | "neutral";

type ToneClasses = {
  /** Saturated foreground (glyph/text) on a neutral surface. */
  text: string;
  /** Outlined pill: low-alpha surface + mid-alpha hairline + saturated text. */
  pill: string;
  /** Filled dot/glyph fill. */
  dot: string;
  /** Tinted surface emphasis (e.g. aging rows). */
  surface: string;
};

export const STATUS_TONE_CLASSES: Record<StatusTone, ToneClasses> = {
  live: {
    text: "text-status-live",
    pill: "border border-status-live-border bg-status-live-bg text-status-live",
    dot: "bg-status-live",
    surface: "bg-status-live-bg",
  },
  waiting: {
    text: "text-status-waiting",
    pill: "border border-status-waiting-border bg-status-waiting-bg text-status-waiting",
    dot: "bg-status-waiting",
    surface: "bg-status-waiting-bg",
  },
  blocking: {
    text: "text-status-blocking",
    pill: "border border-status-blocking-border bg-status-blocking-bg text-status-blocking",
    dot: "bg-status-blocking",
    surface: "bg-status-blocking-bg",
  },
  ok: {
    text: "text-status-ok",
    pill: "border border-status-ok-border bg-status-ok-bg text-status-ok",
    dot: "bg-status-ok",
    surface: "bg-status-ok-bg",
  },
  review: {
    text: "text-status-review",
    pill: "border border-status-review-border bg-status-review-bg text-status-review",
    dot: "bg-status-review",
    surface: "bg-status-review-bg",
  },
  neutral: {
    text: "text-status-neutral",
    pill: "border border-status-neutral-border bg-status-neutral-bg text-status-neutral",
    dot: "bg-status-neutral",
    surface: "bg-status-neutral-bg",
  },
};

/** Human-facing state → tone + capitalized label. One name per state. */
export const STATUS_BADGE_VARIANTS: Record<
  StatusBadgeVariant,
  { tone: StatusTone; label: string }
> = {
  pending: { tone: "waiting", label: "Pending" },
  resolving: { tone: "live", label: "Resolving" },
  approved: { tone: "ok", label: "Approved" },
  denied: { tone: "blocking", label: "Denied" },
  review: { tone: "review", label: "In review" },
  neutral: { tone: "neutral", label: "Neutral" },
};

export function statusToneOf(variant: StatusBadgeVariant): StatusTone {
  return STATUS_BADGE_VARIANTS[variant].tone;
}

export function statusBadgeLabel(variant: StatusBadgeVariant): string {
  return STATUS_BADGE_VARIANTS[variant].label;
}

/** Resolved class bundle for a badge variant (pill + dot + label). */
export function statusBadgeClasses(variant: StatusBadgeVariant): {
  pill: string;
  dot: string;
  label: string;
} {
  const { tone, label } = STATUS_BADGE_VARIANTS[variant];
  return {
    pill: STATUS_TONE_CLASSES[tone].pill,
    dot: STATUS_TONE_CLASSES[tone].dot,
    label,
  };
}
