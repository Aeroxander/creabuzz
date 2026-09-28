import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/** A known value, optionally with a human label ("m1 — Testnet live"). */
export interface HashOption {
  value: string;
  label?: string;
}

/**
 * Pick-from-the-list hash/identifier input (the "no manual hashes" rule):
 * known values are a dropdown — a founder should never paste a hash to do
 * routine work. "Enter manually…" stays available for the one legitimate
 * case (a value that exists only elsewhere), and it is visibly secondary.
 */
export function HashPicker({
  id,
  label,
  value,
  options,
  onValueChange,
  placeholder,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  /** Known values, newest first. Strings are their own labels. */
  options: readonly (HashOption | string)[];
  onValueChange: (value: string) => void;
  placeholder: string;
  testId?: string;
}) {
  const normalized: HashOption[] = options.map((option) =>
    typeof option === "string" ? { value: option } : option,
  );
  const [custom, setCustom] = useState(normalized.length === 0);
  const known = normalized.some((option) => option.value === value);

  return (
    <div>
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {custom ? (
        <>
          <Input
            id={id}
            data-testid={testId}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={placeholder}
            value={value}
          />
          {normalized.length > 0 ? (
            <Button
              onClick={() => {
                setCustom(false);
                onValueChange(normalized[0].value);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Choose from list
            </Button>
          ) : null}
        </>
      ) : (
        <select
          className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          data-testid={testId}
          id={id}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustom(true);
              onValueChange("");
            } else {
              onValueChange(e.target.value);
            }
          }}
          value={known ? value : (normalized[0]?.value ?? "")}
        >
          {normalized.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
          <option value="__custom__">Enter manually…</option>
        </select>
      )}
    </div>
  );
}
