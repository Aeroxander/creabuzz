import { toast } from "sonner";

import { Button } from "@/shared/ui/button";

/**
 * Small pieces the project panels share (contributor funds, decisions, work, and
 * the raise panels): a step row, a copyable address, the account strip, the
 * reason a panel cannot send yet, the polite status line, and the shared
 * `FailureNote` (`@/shared/ui/failure-note`). This file only renders.
 */

/** One row of a step list. The marker is decorative — the status text carries the meaning. */
export function StepRow({
  testId,
  marker,
  label,
  detail,
  status,
}: {
  testId: string;
  marker: string;
  label: string;
  detail: string;
  status: string;
}) {
  return (
    <li
      className="grid grid-cols-[1.25rem_1fr] items-baseline gap-x-2 text-sm text-black/80 dark:text-white/80"
      data-testid={testId}
    >
      <span aria-hidden className="text-black/50 dark:text-white/50">
        {marker}
      </span>
      <span>
        <span className="font-medium">{label}</span>{" "}
        <span className="text-black/60 dark:text-white/60">{detail}</span>{" "}
        <span className="font-medium">{status}</span>
      </span>
    </li>
  );
}

/** A contract address or hash with a copy button. */
export function AddressRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Copy failed. Select the text and copy it manually.");
    }
  };
  return (
    <div className="mt-2 flex min-w-0 items-start gap-2 rounded-lg bg-black/5 px-2 py-1.5 dark:bg-white/10">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-black/60 dark:text-white/60">
          {label}
        </div>
        <div className="break-all font-mono text-xs">{value}</div>
      </div>
      <Button
        aria-label={copyLabel}
        onClick={copy}
        size="sm"
        type="button"
        variant="ghost"
      >
        Copy
      </Button>
    </div>
  );
}

/** The account strip lives in its own file; kept here for the panels that import it with the rest. */
export { WalletStrip } from "./AccountStrip";

/** A failed send: the app's one `FailureNote`, here for the panels that import it with the rest. */
export { FailureNote } from "@/shared/ui/failure-note";

/** The reason a panel cannot send yet, when there is one. */
export function GateNote({
  gate,
  testId,
  id,
}: {
  gate: { ok: true } | { ok: false; message: string };
  testId: string;
  /** Lets the buttons this note explains name it in `aria-describedby`. */
  id?: string;
}) {
  if (gate.ok) return null;
  return (
    <p
      className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 [overflow-wrap:anywhere] dark:bg-amber-950 dark:text-amber-100"
      data-testid={testId}
      id={id}
      role="status"
    >
      {gate.message}
    </p>
  );
}

/**
 * The polite status line. The live region is always in the document (a region
 * that appears together with its text is not announced), but it takes no room
 * while empty: it is visually hidden until it has something to say.
 */
export function StatusLine({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      aria-live="polite"
      className={
        text ? "mt-2 text-sm text-black/60 dark:text-white/60" : "sr-only"
      }
      data-testid={testId}
      role="status"
    >
      {text}
    </p>
  );
}
