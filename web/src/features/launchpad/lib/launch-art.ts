/**
 * A cover for a launch that has no image of its own.
 *
 * Deterministic from the launch id, so a card looks the same on every visit and
 * on every device, and two launches next to each other rarely match. Pure and
 * alias-free: covered by `launch-art.test.mjs`.
 */

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}

/** Hues the brand palette lives in: violets, blues, teals and a warm pink. */
const HUES = [262, 280, 300, 330, 215, 190, 160] as const;

export interface LaunchArt {
  /** A complete CSS `background` value. */
  background: string;
}

export function launchArt(seed: string): LaunchArt {
  const h = hash(seed || "launch");
  const a = HUES[h % HUES.length];
  const b = HUES[(h >>> 8) % HUES.length];
  const angle = 115 + ((h >>> 16) % 90);
  const x = 15 + ((h >>> 4) % 70);
  const y = 10 + ((h >>> 12) % 60);
  return {
    background: [
      `radial-gradient(circle at ${x}% ${y}%, hsl(${b} 90% 62% / 0.55), transparent 55%)`,
      `linear-gradient(${angle}deg, hsl(${a} 62% 30%), hsl(${b} 55% 14%))`,
    ].join(", "),
  };
}
