import { cn } from "@/shared/lib/cn";

/** Twitter-style tab strip with an underline on the active tab. */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (tab: T) => void;
}) {
  return (
    <div role="tablist" className="flex">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className="relative flex h-[53px] flex-1 items-center justify-center text-[15px] transition-colors hover:bg-foreground/5"
        >
          <span
            className={cn(
              "relative flex h-full items-center",
              value === tab.id
                ? "font-bold"
                : "font-medium text-muted-foreground",
            )}
          >
            {tab.label}
            {value === tab.id && (
              <span className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-primary" />
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
