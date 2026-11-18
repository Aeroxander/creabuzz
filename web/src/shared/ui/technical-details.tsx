import { cn } from "@/shared/lib/cn";

/**
 * The raw words behind a failure (the server's or the browser's own), collapsed under "Technical details" for whoever
 * helps, so main copy stays plain. Renders nothing when there is nothing more to show.
 */
export function TechnicalDetails({
  detail,
  testId,
  className,
}: {
  detail: string | null;
  testId?: string;
  className?: string;
}) {
  if (!detail) return null;
  return (
    <details
      className={cn("text-xs text-black/60 dark:text-white/60", className)}
      data-testid={testId}
    >
      <summary className="cursor-pointer select-none font-medium">
        Technical details
      </summary>
      <p className="mt-1 break-words">{detail}</p>
    </details>
  );
}
