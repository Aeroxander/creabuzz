/**
 * Theme bootstrap, loaded before the app bundle.
 *
 * Mirrors `ThemeProvider.getInitialTheme`: an explicit choice from the profile
 * menu wins, otherwise the system preference. Kept as a separate file rather
 * than an inline script so the document can carry a Content-Security-Policy
 * without a script hash. Storage key and semantics must stay in step with
 * `src/shared/theme/ThemeProvider.tsx`.
 */
(() => {
  var stored = null;
  try {
    stored = window.localStorage.getItem("buzz.theme");
  } catch {
    stored = null;
  }
  var dark =
    stored === "dark" ||
    (stored !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.add(dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
