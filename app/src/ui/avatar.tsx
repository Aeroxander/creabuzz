import { cn } from "./cn";

const SIZES = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-16 w-16 text-xl",
};

/** A stable hue for a person, so the same person always has the same colour. */
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
 * A person's initials on their colour. No picture is ever fetched from a web address, so drawing a name never tells a
 * stranger's server that someone looked. Decorative: the name next to it is what a screen reader reads, so it is not read
 * twice.
 */
export function Avatar({
  name,
  pubkey,
  size = "md",
  className,
}: {
  name: string;
  pubkey: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const hue = hueOf(pubkey);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full border border-white/30 font-semibold text-ink",
        SIZES[size],
        className,
      )}
      data-testid="avatar"
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 55% 40%), hsl(${(hue + 40) % 360} 55% 28%))`,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
