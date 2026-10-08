import { type ReactNode, useId } from "react";

import { Input } from "@/shared/ui/input";

/** One labelled field with an optional hint, wired so a screen reader reads label, hint and input together. */
export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="font-medium" htmlFor={id}>
        {label}
      </label>
      {children({ id, "aria-describedby": hintId })}
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
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId: string;
  inputMode?: "decimal" | "numeric" | "text";
}) {
  return (
    <FormField hint={hint} label={label}>
      {(props) => (
        <Input
          {...props}
          data-testid={testId}
          inputMode={inputMode}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          value={value}
        />
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
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId: string;
  rows?: number;
}) {
  return (
    <FormField hint={hint} label={label}>
      {(props) => (
        <textarea
          {...props}
          className="rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          data-testid={testId}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          value={value}
        />
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
