import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { POOL_PCT } from "../lib/manifest";

export interface RoleRow {
  /** Stable React key — row identity survives adds and removes. */
  uid: number;
  label: string;
  pct: string;
}

/** A labelled pitch field with one place for its help or validation message. */
export function PitchField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      <p
        className={cn(
          "mt-1.5 text-xs",
          error ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
        )}
        data-testid={error ? `${id}-error` : undefined}
        id={`${id}-feedback`}
        role={error ? "alert" : undefined}
      >
        {error ?? hint}
      </p>
    </div>
  );
}

/** Keep labels, inputs and removal actions on the same grid in every row. */
export function RoleRowInputs({
  row,
  index,
  onChange,
  onRemove,
  invalid,
}: {
  row: RoleRow;
  index: number;
  onChange: (next: RoleRow) => void;
  onRemove?: () => void;
  invalid: boolean;
}) {
  const roleLabel = index === 0 ? "Your role" : `Role ${index}`;
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_5.5rem_2.25rem] items-end gap-2"
      data-testid={`pitch-role-row-${index}`}
    >
      <div className="min-w-0">
        <label className="text-sm font-medium" htmlFor={`role-label-${index}`}>
          {roleLabel}
        </label>
        <Input
          aria-describedby={invalid ? "pitch-roles-error" : undefined}
          aria-invalid={invalid || undefined}
          className="mt-1.5 h-10 bg-background/60"
          id={`role-label-${index}`}
          maxLength={64}
          onChange={(e) => onChange({ ...row, label: e.target.value })}
          placeholder={index === 0 ? "The founder" : "The designer"}
          value={row.label}
        />
      </div>
      <div className="min-w-0">
        <label className="text-sm font-medium" htmlFor={`role-pct-${index}`}>
          Stake <span className="sr-only">for {roleLabel.toLowerCase()}</span>
        </label>
        <div className="relative mt-1.5">
          <Input
            aria-describedby={invalid ? "pitch-roles-error" : undefined}
            aria-invalid={invalid || undefined}
            className="h-10 bg-background/60 pr-7 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            id={`role-pct-${index}`}
            inputMode="numeric"
            max={POOL_PCT}
            min={1}
            onChange={(e) => onChange({ ...row, pct: e.target.value })}
            step={1}
            type="number"
            value={row.pct}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
          >
            %
          </span>
        </div>
      </div>
      {onRemove ? (
        <Button
          aria-label={`Remove role ${row.label || index}`}
          className="h-10 w-9 text-muted-foreground"
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      ) : (
        <span aria-hidden />
      )}
    </div>
  );
}

/** Declared stakes are a proposal, including any pool left for future roles. */
export function StakeSummary({
  founder,
  openRoles,
}: {
  founder: RoleRow;
  openRoles: readonly RoleRow[];
}) {
  const yours = Number(founder.pct) || 0;
  const open = openRoles.reduce(
    (total, role) => total + (Number(role.pct) || 0),
    0,
  );
  const declared = yours + open;
  const remaining = Math.max(0, POOL_PCT - declared);
  const over = declared > POOL_PCT;
  const founderWidth = Math.max(0, Math.min(POOL_PCT, yours));
  const openWidth = Math.max(0, Math.min(POOL_PCT - founderWidth, open));
  return (
    <div className="rounded-xl border border-border/60 bg-foreground/[0.04] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Stake allocation</h3>
        <p
          className={cn(
            "text-xs tabular-nums",
            over
              ? "font-semibold text-red-600 dark:text-red-400"
              : "text-muted-foreground",
          )}
          data-testid="pitch-pool"
        >
          {declared}% of {POOL_PCT}% declared
        </p>
      </div>
      <div
        aria-hidden
        className="mt-3 flex h-2 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={over ? "bg-red-500" : "bg-primary"}
          style={{ width: `${founderWidth}%` }}
        />
        <div
          className={over ? "bg-red-500/50" : "bg-primary/40"}
          style={{ width: `${openWidth}%` }}
        />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        {[
          ["Your role", yours],
          ["Open roles", open],
          ["Unassigned", remaining],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums">
              {value}%
            </dd>
          </div>
        ))}
      </dl>
      {over ? (
        <p
          className="mt-3 text-xs text-red-600 dark:text-red-400"
          role="status"
        >
          Reduce the stakes by {declared - POOL_PCT}% to fit the pool.
        </p>
      ) : null}
    </div>
  );
}
