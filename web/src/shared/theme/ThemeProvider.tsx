import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type Theme = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Storage key for the user's theme choice.
 *
 * `public/theme-boot.js` reads the same key before the bundle runs, so dark-mode
 * users never see a white flash; keep the two in step.
 */
export const THEME_STORAGE_KEY = "buzz.theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function getInitialTheme(): Theme {
  if (import.meta.env.DEV) {
    const previewTheme = new URLSearchParams(window.location.search).get(
      "previewTheme",
    );
    if (isTheme(previewTheme) && previewTheme !== "system") return previewTheme;
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage unavailable: fall through to the system preference.
  }
  return "system";
}

function applyClass(isDark: boolean) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(isDark ? "dark" : "light");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const [isDark, setIsDark] = useState<boolean>(() => {
    const initialTheme = getInitialTheme();
    const dark =
      initialTheme === "system" ? getSystemDark() : initialTheme === "dark";
    applyClass(dark);
    return dark;
  });

  useEffect(() => {
    const dark = theme === "system" ? getSystemDark() : theme === "dark";
    applyClass(dark);
    setIsDark(dark);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      applyClass(e.matches);
      setIsDark(e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      // Persisted so the next load paints the right colours immediately.
      window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // Storage unavailable: the choice holds for this session only.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
