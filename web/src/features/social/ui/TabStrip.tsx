import { cn } from "@/shared/lib/cn";

/** Underlined tabs along the top of a timeline. */
export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (tab: T) => void;
  label: string;
}) {
  return (
    <div aria-label={label} className="flex" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={value === tab.id}
          className="relative flex h-12 flex-1 items-center justify-center text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          data-testid={`social-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          type="button"
        >
          <span
            className={cn(
              "relative flex h-full items-center",
              value === tab.id
                ? "font-bold text-black dark:text-white"
                : "font-medium text-black/60 dark:text-white/60",
            )}
          >
            {tab.label}
            {value === tab.id ? (
              <span className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-primary" />
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}
