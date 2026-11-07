import { type ReactNode, useId, useMemo } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Input } from "@/shared/ui/input";
import { usePeopleWithWallets } from "../use-people";

/**
 * One labelled field with an optional hint and problem, wired so a screen reader reads label, problem, hint and input
 * together, and a field with a problem is marked invalid where it is (not only in a message by the button).
 */
export function FormField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /** What is wrong with what was typed here, shown under the field; the field is then marked invalid. */
  error?: string | null;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="font-medium" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {error ? (
        <span className="text-xs text-destructive" id={errorId}>
          {error}
        </span>
      ) : null}
      {hint ? (
        <span className="text-xs text-muted-foreground" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  testId,
  inputMode,
  after,
  error,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId: string;
  inputMode?: "decimal" | "numeric" | "text";
  /** Something that helps fill this in, shown under the box (a list of people to pick from). */
  after?: ReactNode;
  error?: string | null;
}) {
  return (
    <FormField error={error} hint={hint} label={label}>
      {(props) => (
        <>
          <Input
            {...props}
            data-testid={testId}
            inputMode={inputMode}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            value={value}
          />
          {after}
        </>
      )}
    </FormField>
  );
}

export function TextAreaField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  testId,
  rows = 3,
  after,
  error,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId: string;
  rows?: number;
  after?: ReactNode;
  error?: string | null;
}) {
  return (
    <FormField error={error} hint={hint} label={label}>
      {(props) => (
        <>
          <textarea
            {...props}
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            data-testid={testId}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            value={value}
          />
          {after}
        </>
      )}
    </FormField>
  );
}

export function SelectField({
  label,
  hint,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  testId: string;
}) {
  return (
    <FormField hint={hint} label={label}>
      {(props) => (
        <select
          {...props}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          data-testid={testId}
          onChange={(e) => onChange(e.target.value)}
          value={value}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

/**
 * "Add someone you know": the people on this server who have bound a wallet, by name. Picking one puts their wallet
 * address into the box above, so nobody has to copy an address from somewhere else. Shown only when there is someone
 * to pick; typing an address still works for everyone else.
 */
export function PeoplePicker({
  onPick,
  testId,
  exclude = [],
}: {
  onPick: (address: string) => void;
  testId: string;
  /** People not to offer, by public key (the founder, when picking their reviewers). */
  exclude?: readonly string[];
}) {
  const all = usePeopleWithWallets();
  const people = {
    data: all.data?.filter((person) => !exclude.includes(person.pubkey)),
  };
  const keys = useMemo(
    () => (people.data ?? []).map((person) => person.pubkey),
    [people.data],
  );
  const nameOf = useUserNames(keys);
  if (!people.data || people.data.length === 0) return null;
  // A name alone, unless two people share it: then their short addresses tell them apart.
  const named = people.data.map((person) => nameOf(person.pubkey));
  const shared = (name: string) =>
    named.filter((other) => other === name).length > 1;
  return (
    <select
      aria-label="Add someone you know"
      className="h-8 w-fit rounded-md border border-input bg-transparent px-2 text-xs"
      data-testid={testId}
      onChange={(event) => {
        if (event.target.value) onPick(event.target.value);
      }}
      value=""
    >
      <option value="">Add someone you know…</option>
      {people.data.map((person) => (
        <option key={person.pubkey} value={person.address}>
          {nameOf(person.pubkey)}
          {shared(nameOf(person.pubkey))
            ? ` · ${person.address.slice(0, 6)}…${person.address.slice(-4)}`
            : ""}
        </option>
      ))}
    </select>
  );
}
