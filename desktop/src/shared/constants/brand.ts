/**
 * The product name people see. Every user-facing mention of the product comes
 * from here, so a rename is one edit (the repository, crates and storage keys
 * keep their internal `buzz` names on purpose — renaming those would lose
 * people's stored keys and settings).
 */
export const APP_NAME = "Creaton";

/**
 * The hosted Creaton web app — where people use their Creaton account in a
 * browser. Used as the fallback "Sign in with browser" address when no
 * community is connected yet (a connected community's own relay serves its
 * web app and always wins).
 */
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000"; // LOCALHOST-ONLY for now: the relay serves the web bundle in dev (ws://localhost:3000). No production domain is claimed — point this at a real hosted origin before release.
