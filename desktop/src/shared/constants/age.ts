/** The age the terms, the privacy note and the sign-up box all use. Change it here and nowhere else. */
export const MINIMUM_AGE = 18;

/** The sign-up box that confirms it (shown when the community's server asks for it). */
export const AGE_CONFIRMATION = `I am ${MINIMUM_AGE} years of age or older.`;

/** Shown when someone tries to go on without ticking that box. */
export const AGE_CONFIRMATION_NEEDED = `Confirm that you are at least ${MINIMUM_AGE} years old.`;
