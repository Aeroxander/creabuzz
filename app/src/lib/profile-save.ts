import { KIND_PROFILE } from "@creaton/core/kinds.ts";
import { publishAsUser, readLatest } from "./relay";

const READ_FAILED =
  "Your profile could not be read, so nothing was changed. Try again.";

/**
 * Publish the person's profile with `name` and `about`, keeping every other field their newest profile already has
 * (a picture set in another app is not erased).
 *
 * A failed read stops the save: publishing from an empty profile then would wipe every other field. Only a read that
 * finds no profile at all starts from empty, and only where none is expected (`expectExisting` false, as at sign-up).
 */
export async function saveProfile(
  pubkey: string,
  fields: { name: string; about?: string },
  { expectExisting = false }: { expectExisting?: boolean } = {},
): Promise<void> {
  let latest: Awaited<ReturnType<typeof readLatest>>;
  try {
    latest = await readLatest(KIND_PROFILE, pubkey);
  } catch {
    throw new Error(READ_FAILED);
  }
  if (!latest && expectExisting) throw new Error(READ_FAILED);
  let current: Record<string, unknown> = {};
  if (latest) {
    try {
      const parsed: unknown = JSON.parse(latest.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        current = parsed as Record<string, unknown>;
    } catch {
      // The newest profile is not readable as a profile at all: there is nothing in it to keep.
    }
  }
  const name = fields.name.trim();
  const content: Record<string, unknown> = {
    ...current,
    name,
    display_name: name,
  };
  if (fields.about !== undefined) {
    const about = fields.about.trim();
    if (about) content.about = about;
    else delete content.about;
  }
  await publishAsUser(
    { kind: KIND_PROFILE, tags: [], content: JSON.stringify(content) },
    "Your name could not be saved. Try again.",
  );
}
