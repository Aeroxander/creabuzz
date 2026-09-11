/**
 * Theme bootstrap, loaded before the app bundle.
 *
 * Production theme is system-only (`ThemeProvider.getInitialTheme`), so this
 * mirrors it exactly. Kept as a separate file rather than an inline script so
 * the document can carry a Content-Security-Policy without a script hash.
 */
(function () {
  var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.add(dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
