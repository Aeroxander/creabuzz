import { type ReactNode, useId } from "react";

/** A titled block of Home: a labelled region with its heading. */
export function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3"
      data-testid={testId}
    >
      <h2
        className="text-sm font-semibold uppercase tracking-wider text-muted"
        id={id}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
