/**
 * The name someone picks for a community of their own, and the address it becomes.
 *
 * A name is the part before the server's domain: `acme` on `creaton.example` becomes `acme.creaton.example`. The server
 * has the final say (it also keeps some words back for itself and says if a name is taken); this only tidies what was
 * typed and catches the mistakes that need no answer from the server, in plain words, so the person is told while typing.
 *
 * Alias-free for `node --test`.
 */

/** What the server accepts when it does not say otherwise. */
export const DEFAULT_LIMITS = { min: 3, max: 32 } as const;

export interface NameLimits {
  min: number;
  max: number;
}

/**
 * Tidy what was typed into a name as it is typed: lower case, spaces and underscores become hyphens, anything else that
 * a name cannot hold is dropped, and runs of hyphens become one. Hyphens at the ends are kept (a person types
 * "my-" on the way to "my-film"); `finishName` removes them.
 */
export function tidyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-");
}

/** The name to send: tidied, and with no hyphens at the ends. */
export function finishName(raw: string): string {
  return tidyName(raw).replace(/^-+|-+$/g, "");
}

/**
 * What is wrong with a finished name, in words to show, or null when nothing the browser can see is. Reserved words and
 * taken names are the server's to say.
 */
export function nameProblem(
  name: string,
  limits: NameLimits = DEFAULT_LIMITS,
): string | null {
  if (name.length === 0) return "Pick a name for your community.";
  if (name.length < limits.min) {
    return `Names need at least ${limits.min} letters or numbers.`;
  }
  if (name.length > limits.max) {
    return `Names can be at most ${limits.max} letters or numbers.`;
  }
  if (name[2] === "-" && name[3] === "-") {
    return "Pick a name that does not have hyphens as its third and fourth characters.";
  }
  return null;
}

/** The address a name becomes, as a person reads it: `acme.creaton.example`. */
export function previewHost(name: string, domain: string): string {
  return `${name}.${domain}`;
}

/**
 * Where the signed create request goes: the server's management origin. A deployment that hosts the app apart from its
 * servers says so with `VITE_COMMUNITY_API_ORIGIN`; otherwise the app is served by the server itself and its own origin
 * is the one. Returns null for a value that is not an http(s) origin, so a typo cannot send a signed request elsewhere.
 */
export function pickApiOrigin(
  configured: string | undefined,
  pageOrigin: string,
): string | null {
  const value = (configured?.trim() || pageOrigin).replace(/\/+$/, "");
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
