// The ONE flag's promise, held in the code itself: nothing outside the legacy set imports a legacy module, except the glue
// in `src/legacy/`, and that only as a lazy `import()` that the flag guards. A new import that reaches an old screen from a
// live one fails here, before a person could ever see it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

/** Every file of the old money design that went behind the flag. Anything not matched here is live. */
const LEGACY: RegExp[] = [
  /^features\/market\//,
  /^features\/earlier\//,
  /^features\/money\/(BackBox|OpenBacking|OpenRounds|Receipts|MoneyTab|numbers-v1|numbers-market|calls-v1|use-money-v1)\./,
  /^features\/money\/numbers-v1\.test\./,
  /^features\/money\/calls-v1\.test\./,
  /^features\/money\/money-(screens|sends|gates)\.test\./,
  /^features\/project\/StageLine/,
  /^features\/team\/(TeamTop|TeamMoney|PairCard|PersonTeamActions|MemberActions|SendSheet|LaunchProject|launch|pair|use-team-v1|team-calls|team-copy)\./,
  /^features\/team\/(team-calls|team-copy|team-screens|team-runner|proposal-terms|failed-sale-retry|winddown-copy)\.test\./,
];
/** The glue that mounts the legacy screens (loaded only with the flag). */
const GLUE = /^legacy\//;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const ALL = files(SRC).map((p) => relative(SRC, p));
const isLegacy = (rel: string) => LEGACY.some((r) => r.test(rel));
const isGlue = (rel: string) => GLUE.test(rel);

interface Import {
  from: string;
  spec: string;
  dynamic: boolean;
}

/** The relative imports of a file: static `from "x"` and `import("x")`. */
function importsOf(rel: string): Import[] {
  const text = readFileSync(join(SRC, rel), "utf8");
  const out: Import[] = [];
  for (const m of text.matchAll(/\bfrom\s+"(\.[^"]*)"/g))
    out.push({ from: rel, spec: m[1] as string, dynamic: false });
  for (const m of text.matchAll(/\bimport\(\s*"(\.[^"]*)"/g))
    out.push({ from: rel, spec: m[1] as string, dynamic: true });
  for (const m of text.matchAll(/vi\.mock\(\s*"(\.[^"]*)"/g))
    out.push({ from: rel, spec: m[1] as string, dynamic: false });
  return out;
}

/** The file (relative to src) a relative specifier names, or null when it is not a file of src (a test helper, a css). */
function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(SRC, dirname(from), spec);
  const rel = relative(SRC, base);
  if (rel.startsWith("..")) return null;
  for (const candidate of [
    rel,
    `${rel}.ts`,
    `${rel}.tsx`,
    `${rel}/index.ts`,
    `${rel}/index.tsx`,
  ])
    if (ALL.includes(candidate)) return candidate;
  return null;
}

describe("the legacy-screens boundary", () => {
  it("lists real files, and every file of the market and earlier-backers folders is on the list", () => {
    expect(ALL.filter(isLegacy).length).toBeGreaterThan(50);
    for (const rel of ALL.filter((r) =>
      /^features\/(market|earlier)\//.test(r),
    ))
      expect(isLegacy(rel), rel).toBe(true);
    // Each pattern names at least one file: a stale pattern would hide a rename.
    for (const pattern of LEGACY)
      expect(
        ALL.some((r) => pattern.test(r)),
        String(pattern),
      ).toBe(true);
  });

  it("no live file imports a legacy file; the live files reach the glue only through a lazy import", () => {
    const breaks: string[] = [];
    for (const rel of ALL) {
      if (isLegacy(rel) || isGlue(rel)) continue;
      for (const imp of importsOf(rel)) {
        const target = resolveSpec(rel, imp.spec);
        if (!target) continue;
        if (isLegacy(target)) breaks.push(`${rel} imports legacy ${target}`);
        if (isGlue(target) && !imp.dynamic)
          breaks.push(`${rel} imports the legacy glue ${target} statically`);
      }
    }
    expect(breaks).toEqual([]);
  });

  it("the live files that reach the glue guard it with the flag", () => {
    const reaching = ALL.filter(
      (rel) =>
        !isLegacy(rel) &&
        !isGlue(rel) &&
        importsOf(rel).some(
          (imp) => resolveSpec(rel, imp.spec)?.startsWith("legacy/") === true,
        ),
    );
    expect(reaching.length).toBeGreaterThan(0);
    for (const rel of reaching) {
      if (/\.test\./.test(rel)) continue;
      expect(readFileSync(join(SRC, rel), "utf8"), rel).toMatch(
        /legacyScreensOn|createAppRouter/,
      );
    }
  });
});
