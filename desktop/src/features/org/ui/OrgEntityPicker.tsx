import { Check, ChevronDown, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { PubKey } from "@/shared/ui/PubKey";

import { filterPickerOptions } from "../lib/pickerOptions";

export type OrgPickerOption = {
  id: string;
  label: string;
  /** Secondary line — also part of search matching. */
  sub?: string;
  /** Trailing kind badge (e.g. node kind). */
  kindBadge?: string;
  /** Trailing pubkey chip rendered via <PubKey>. */
  pubkey?: string;
};

type BaseProps = {
  options: OrgPickerOption[];
  /** Visible field label, dialog title, and trigger fallback text. */
  triggerLabel: string;
  searchPlaceholder?: string;
  /** Empty-state message; should name the next action. */
  emptyMessage?: string;
  disabled?: boolean;
};

export type OrgEntityPickerSingleProps = BaseProps & {
  mode: "single";
  selected: string | null;
  onChange: (id: string | null) => void;
};

export type OrgEntityPickerMultiProps = BaseProps & {
  mode: "multi";
  selected: string[];
  onChange: (ids: string[]) => void;
};

export type OrgEntityPickerProps =
  | OrgEntityPickerSingleProps
  | OrgEntityPickerMultiProps;

/**
 * Searchable entity picker for org forms: a button-triggered dialog listing
 * options with title + sub + trailing chip/badge. Humans never type raw IDs;
 * single mode replaces the selection and closes, multi mode toggles and
 * stays open. Keyboard: ArrowUp/Down move the active option, Enter selects,
 * Escape closes the dialog.
 */
export function OrgEntityPicker(props: OrgEntityPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const labelId = React.useId();
  const valueId = React.useId();

  const selectedIds =
    props.mode === "single"
      ? props.selected
        ? [props.selected]
        : []
      : props.selected;
  const filtered = React.useMemo(
    () => filterPickerOptions(props.options, query),
    [props.options, query],
  );
  const selectedOptions = React.useMemo(
    () =>
      selectedIds
        .map((id) => props.options.find((option) => option.id === id))
        .filter((option): option is OrgPickerOption => Boolean(option)),
    [selectedIds, props.options],
  );

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const toggle = React.useCallback(
    (id: string) => {
      if (props.mode === "single") {
        props.onChange(id);
        setOpen(false);
        return;
      }
      props.onChange(
        props.selected.includes(id)
          ? props.selected.filter((existing) => existing !== id)
          : [...props.selected, id],
      );
    },
    [props],
  );

  const removeSelection = React.useCallback(
    (id: string) => {
      if (props.mode === "multi") {
        props.onChange(props.selected.filter((existing) => existing !== id));
      }
    },
    [props],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement
    ) {
      // Enter selects from the search box; when an option button itself has
      // focus, its native activation already toggles — do not double-fire.
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) toggle(option.id);
    }
    // Escape: the Radix dialog closes on Escape.
  };

  const selectedLabel =
    props.mode === "single" && selectedOptions.length > 0
      ? selectedOptions[0].label
      : "";

  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-foreground" id={labelId}>
        {props.triggerLabel}
      </span>
      {props.mode === "multi" && selectedOptions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selectedOptions.map((option) => (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary"
              key={option.id}
            >
              {option.label}
              <button
                aria-label={`Remove ${option.label}`}
                className="ml-0.5 text-primary/60 hover:text-primary"
                disabled={props.disabled}
                onClick={() => removeSelection(option.id)}
                type="button"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Dialog onOpenChange={setOpen} open={open}>
        <Button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-labelledby={`${labelId} ${valueId}`}
          className="h-9 w-full justify-between px-3 font-normal"
          disabled={props.disabled}
          onClick={() => setOpen(true)}
          type="button"
          variant="outline"
        >
          <span className="min-w-0 truncate" id={valueId}>
            {props.mode === "single"
              ? selectedLabel || `Select ${props.triggerLabel.toLowerCase()}...`
              : selectedIds.length > 0
                ? `${selectedIds.length} selected`
                : `Select ${props.triggerLabel.toLowerCase()}...`}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
        </Button>
        <ChooserDialogContent
          className="max-w-lg"
          contentClassName="pt-3"
          title={props.triggerLabel}
        >
          <div className="space-y-2">
            <Input
              aria-label={
                props.searchPlaceholder ??
                `Search ${props.triggerLabel.toLowerCase()}`
              }
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={props.searchPlaceholder ?? "Search..."}
              value={query}
            />
            <div
              aria-label={props.triggerLabel}
              aria-multiselectable={props.mode === "multi"}
              className="max-h-64 overflow-y-auto rounded-md border border-border/60"
              role="listbox"
            >
              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {props.emptyMessage ??
                    `No matches for "${query.trim()}". Try a different search.`}
                </p>
              ) : (
                filtered.map((option, index) => {
                  const isSelected = selectedIds.includes(option.id);
                  const isActive = index === activeIndex;
                  return (
                    <button
                      aria-selected={isSelected}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left last:border-b-0",
                        isActive && "bg-muted/60",
                        isSelected && "bg-primary/5",
                      )}
                      data-active={isActive}
                      key={option.id}
                      onClick={() => toggle(option.id)}
                      onMouseMove={() => setActiveIndex(index)}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {option.label}
                        </span>
                        {option.sub ? (
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {option.sub}
                          </span>
                        ) : null}
                      </span>
                      {option.kindBadge ? (
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                          {option.kindBadge}
                        </span>
                      ) : null}
                      {option.pubkey ? (
                        <PubKey
                          className="shrink-0 text-xs text-muted-foreground"
                          interactive={false}
                          pubkey={option.pubkey}
                        />
                      ) : null}
                      {isSelected ? (
                        <Check
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0 text-primary"
                        />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </ChooserDialogContent>
      </Dialog>
    </div>
  );
}
