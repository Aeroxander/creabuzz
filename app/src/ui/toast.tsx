import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "./cn";

type Tone = "info" | "done" | "problem";
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}

type Show = (text: string, tone?: Tone) => void;
const ToastContext = createContext<Show>(() => {});

/** How long a note stays: long enough to read a sentence twice. */
const TOAST_MS = 4_500;
/** At most this many at once; an older one makes way. */
const MAX_TOASTS = 3;

/**
 * Short notes at the top of the screen ("Posted", "Could not send"). Announced politely to a screen reader; a
 * problem is announced at once. Each goes by itself, or with a tap.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const remove = useCallback(
    (id: number) => setItems((all) => all.filter((item) => item.id !== id)),
    [],
  );
  const show = useCallback<Show>(
    (text, tone = "info") => {
      const id = next.current++;
      setItems((all) => [...all, { id, text, tone }].slice(-MAX_TOASTS));
      window.setTimeout(() => remove(id), TOAST_MS);
    },
    [remove],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4"
        style={{ paddingTop: "calc(var(--safe-top) + 12px)" }}
      >
        <div aria-live="polite" className="contents" role="status">
          {items
            .filter((item) => item.tone !== "problem")
            .map((item) => (
              <ToastNote item={item} key={item.id} onDone={remove} />
            ))}
        </div>
        <div aria-live="assertive" className="contents" role="alert">
          {items
            .filter((item) => item.tone === "problem")
            .map((item) => (
              <ToastNote item={item} key={item.id} onDone={remove} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastNote({
  item,
  onDone,
}: {
  item: ToastItem;
  onDone: (id: number) => void;
}) {
  return (
    <button
      className={cn(
        "toast-item glass pointer-events-auto w-full max-w-sm rounded-xl px-4 py-3 text-left text-sm",
        item.tone === "problem" && "border-danger/60",
        item.tone === "done" && "border-mint/70",
      )}
      data-testid="toast"
      onClick={() => onDone(item.id)}
      type="button"
    >
      {item.text}
    </button>
  );
}

/** Show a short note: `toast("Posted", "done")`. */
export function useToast(): Show {
  return useContext(ToastContext);
}
