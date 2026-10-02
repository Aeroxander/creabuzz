import creatonMark from "@/assets/creaton-mark.svg";

/**
 * The Creaton "C" mark. One SVG file (`assets/creaton-mark.svg`) feeds the top
 * bar, the favicon and the pages that show the logo, so replacing the artwork
 * is replacing that file.
 */
export function CreatonMark({ className }: { className?: string }) {
  return <img alt="" className={className} src={creatonMark} />;
}
