import type { ReactNode } from "react";

/** One labelled fact of a sheet: the label is the number's accessible name (`dt`), the number is its `dd`. */
export function SheetLine({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="break-words" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}
