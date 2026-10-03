import creatonMark from "@/assets/creaton-mark.svg";

/**
 * The Creaton "C" mark. One SVG file (`assets/creaton-mark.svg`) feeds the top
 * bar, the favicon and the pages that show the logo, so replacing the artwork
 * is replacing that file.
 */
export function CreatonMark({
  className,
  label,
}: {
  className?: string;
  /** Accessible name when the mark is the page's logo; omit when decorative. */
  label?: string;
}) {
  return <img alt={label ?? ""} className={className} src={creatonMark} />;
}
