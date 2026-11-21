/**
 * The pictures of a post: kept on this community's server and fetched with a signed read, drawn at the post's width, each
 * with the description its author gave (read out by a screen reader; without one it is named as having none). A reader can
 * hide a post's pictures from its More menu; a hidden picture is a covered place with one press to show it again.
 */
import type { PostPicture } from "@creaton/core/social/pictures.ts";
import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePictureSrc } from "../../lib/server-media";
import { cn } from "../../ui/cn";
import { pictureKey, useHiddenPictures } from "./hidden-pictures";
import {
  NO_DESCRIPTION,
  PICTURE_LOCKED,
  PICTURE_SIGN_IN,
  PICTURE_UNAVAILABLE,
  SHOW_PICTURE,
} from "./picture-words";

/** Whether `ref`'s element has come within a screen's height of view (true from the start where the browser cannot tell). */
function useNearScreen(ref: { current: Element | null }): boolean {
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
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

/** One picture on this server: the wait, the picture, or why it cannot be shown. */
export function ServerPicture({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  className?: string;
}) {
  const place = useRef<HTMLDivElement | null>(null);
  const near = useNearScreen(place);
  const picture = usePictureSrc(url, { defer: !near });
  const [broken, setBroken] = useState<string | null>(null);
  if (picture.status === "none") return null;
  if (picture.status === "ready" && broken !== picture.src)
    return (
      <img
        alt={alt || NO_DESCRIPTION}
        className={cn("w-full object-cover", className)}
        data-testid="post-picture"
        loading="lazy"
        onError={() => setBroken(picture.src)}
        referrerPolicy="no-referrer"
        src={picture.src}
      />
    );
  if (picture.status === "failed" || picture.status === "ready") {
    const text =
      picture.status === "failed" && picture.reason === "signed-out"
        ? PICTURE_SIGN_IN
        : picture.status === "failed" && picture.reason === "locked"
          ? PICTURE_LOCKED
          : PICTURE_UNAVAILABLE;
    return (
      <p
        className="flex min-h-16 items-center justify-center gap-2 p-3 text-center text-xs text-muted"
        data-testid="post-picture-unavailable"
      >
        <ImageOff aria-hidden="true" className="shrink-0" size={16} />
        {text}
      </p>
    );
  }
  return (
    <div
      aria-hidden="true"
      className="min-h-32 animate-pulse bg-white/10"
      data-testid="post-picture-loading"
      ref={place}
    />
  );
}

/** A post's pictures, in a grid of one or two columns. */
export function PostPictures({
  pictures,
}: {
  pictures: readonly PostPicture[];
}) {
  const { hidden, show } = useHiddenPictures();
  if (pictures.length === 0) return null;
  return (
    <div
      className={cn(
        "relative grid gap-1 overflow-hidden rounded-xl",
        pictures.length > 1 ? "grid-cols-2" : "grid-cols-1",
      )}
      data-testid="post-pictures"
    >
      {pictures.map((picture) => {
        const key = pictureKey(picture.url);
        if (key && hidden.has(key))
          return (
            <button
              className="relative z-10 flex min-h-24 items-center justify-center gap-2 bg-white/10 p-3 text-sm font-semibold"
              data-testid="post-picture-hidden"
              key={picture.url}
              onClick={() => show(key)}
              type="button"
            >
              <ImageOff aria-hidden="true" size={18} />
              {SHOW_PICTURE}
            </button>
          );
        return (
          <ServerPicture
            alt={picture.alt}
            className={pictures.length > 1 ? "aspect-square" : "max-h-96"}
            key={picture.url}
            url={picture.url}
          />
        );
      })}
    </div>
  );
}
