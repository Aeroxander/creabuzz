/**
 * A profile has two name fields, `display_name` and `name`. Sign-up and the account menu save both as one; the profile
 * editor shows one ("Name"). So when it saves, `name` follows the shown name if it was the same as it (or empty), and
 * is left alone if the person set it to something else elsewhere.
 *
 * Alias-free: `profile-names.test.mjs` drives it under `node --test`.
 */

export function withNameFollowing<
  T extends { display_name: string; name: string },
>(
  values: T,
  saved?: { display_name?: string | undefined; name?: string | undefined },
): T {
  const shown = (saved?.display_name ?? "").trim();
  const other = (saved?.name ?? "").trim();
  return other === "" || other === shown
    ? { ...values, name: values.display_name }
    : values;
}
