import { useState } from "react";
import { cn } from "./cn";

const SIZES = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-16 w-16 text-xl",
};

/** A stable hue for a person, so the same person always has the same colour when they have no picture. */
export function hueOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1)
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** Up to two letters from a name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters =
    words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

/**
 * A person's picture, or their initials on their colour. Decorative by default: the name next to it is what a screen
 * reader reads, so it is not read twice.
 */
export function Avatar({
  name,
  pubkey,
  picture,
  size = "md",
  className,
}: {
  name: string;
  pubkey: string;
  picture?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const hue = hueOf(pubkey);
  const showPicture = Boolean(picture) && !broken;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full border border-white/30 font-semibold text-ink",
        SIZES[size],
        className,
      )}
      data-testid="avatar"
      style={
        showPicture
          ? undefined
          : {
              background: `linear-gradient(160deg, hsl(${hue} 60% 52%), hsl(${(hue + 40) % 360} 55% 34%))`,
            }
      }
    >
      {showPicture ? (
        <img
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setBroken(true)}
          referrerPolicy="no-referrer"
          src={picture ?? undefined}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
