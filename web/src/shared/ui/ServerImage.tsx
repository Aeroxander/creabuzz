import { ImageOff } from "lucide-react";
import { type ImgHTMLAttributes, useEffect, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";
import type { MediaFailure } from "@/shared/lib/server-media";
import { useServerMediaSrc } from "@/shared/lib/use-server-media";

type ServerImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "onError"
> & {
  src: string;
  /** What shows when the picture cannot be: a short note (default), just the icon, or nothing. */
  unavailable?: "note" | "icon" | "hide";
  /** Told once the picture cannot be shown (the server refused it, or it would not load). */
  onUnavailable?: () => void;
  "data-testid"?: string;
};

function unavailableText(reason: MediaFailure | null): string {
  if (reason === "signed-out") return "Sign in to see this picture";
  if (reason === "locked") return "Unlock your passkey to see this picture";
  return "Picture can't be shown";
}

/**
 * Whether `ref`'s element has come within a screen's margin of view. True from
 * the start unless `lazy`, and wherever the browser cannot tell.
 */
function useNearScreen(
  ref: { current: Element | null },
  lazy: boolean,
): boolean {
  const [near, setNear] = useState(
    () => !lazy || typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * An `<img>` that also shows pictures stored on this community's server, which
 * the server hands over only to a signed read (`server-media.ts`). Pictures
 * from anywhere else load directly, exactly like a plain `<img>`.
 */
export function ServerImage({
  src,
  unavailable = "note",
  onUnavailable,
  className,
  alt,
  ...rest
}: ServerImageProps) {
  // `loading="lazy"` keeps its meaning for server pictures too: the signed
  // fetch waits until the picture's place comes near the screen.
  const placeholder = useRef<HTMLSpanElement | null>(null);
  const near = useNearScreen(placeholder, rest.loading === "lazy");
  const media = useServerMediaSrc(src, { defer: !near });
  const shown = media.status === "ready" ? media.src : null;
  // Remembered per address, so a new address gets its own chance to load.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const failed =
    media.status === "failed" || (shown !== null && brokenSrc === shown);
  const reason = media.status === "failed" ? media.reason : null;

  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  useEffect(() => {
    if (failed) onUnavailableRef.current?.();
  }, [failed]);

  const testId = rest["data-testid"];
  if (media.status === "none") return null;
  if (failed) {
    if (unavailable === "hide") return null;
    const text = unavailableText(reason);
    return (
      <span
        aria-label={text}
        className={cn(
          "flex min-h-8 items-center justify-center gap-1.5 rounded-lg border bg-secondary/50 p-2 text-xs text-muted-foreground",
          className,
        )}
        data-testid={testId ? `${testId}-unavailable` : undefined}
        role="img"
        title={text}
      >
        <ImageOff aria-hidden className="h-4 w-4 shrink-0" />
        {unavailable === "note" ? <span aria-hidden>{text}</span> : null}
      </span>
    );
  }
  if (!shown) {
    return (
      <span
        aria-hidden
        className={cn("block min-h-8 bg-secondary/50", className)}
        ref={placeholder}
        data-testid={testId ? `${testId}-loading` : undefined}
      />
    );
  }
  return (
    <img
      {...rest}
      alt={alt}
      className={className}
      onError={() => setBrokenSrc(shown)}
      src={shown}
    />
  );
}
