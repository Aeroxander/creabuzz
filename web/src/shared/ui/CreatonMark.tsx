/**
 * The Creaton "C" in its hexagon. Drawn as SVG so it follows the theme and
 * stays sharp at any size. A stand-in until the brand file's own artwork is
 * exported into the repo; swapping it is this one file.
 */
export function CreatonMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Creaton</title>
      <defs>
        <linearGradient id="creaton-mark" x1="6" x2="34" y1="4" y2="36">
          <stop offset="0" stopColor="#43e5c0" />
          <stop offset="0.55" stopColor="#35cc82" />
          <stop offset="1" stopColor="#5b4bd6" />
        </linearGradient>
      </defs>
      <path
        d="M20 2.5 35.2 11.25v17.5L20 37.5 4.8 28.75v-17.5L20 2.5Z"
        fill="url(#creaton-mark)"
      />
      <path
        d="M25.5 14.2A8.2 8.2 0 1 0 25.5 25.8"
        stroke="#120821"
        strokeLinecap="round"
        strokeWidth="4.2"
      />
    </svg>
  );
}
