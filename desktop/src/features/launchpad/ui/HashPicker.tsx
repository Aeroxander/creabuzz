import { useState } from "react";

/**
 * Pick-from-the-list hash/identifier input (the "no manual hashes" rule,
 * desktop parity with web's `ui/HashPicker.tsx`): known values are a
 * dropdown; "Enter manually…" stays visibly secondary for the one
 * legitimate case.
 */

export interface HashOption {
  value: string;
  label?: string;
}

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
        <div className="flex items-center gap-1">
          <input
            className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            id={id}
            data-testid={testId}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={placeholder}
            value={value}
          />
          {normalized.length > 0 ? (
            <button
              className="mt-1 shrink-0 rounded-md border border-black/15 px-2 py-1.5 text-xs dark:border-white/15"
              onClick={() => {
                setCustom(false);
                onValueChange(normalized[0].value);
              }}
              type="button"
            >
              Choose from list
            </button>
          ) : null}
        </div>
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
