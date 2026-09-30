import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * Reader typography preferences: conversation text size and density.
 *
 * The desktop app's contract is Smaller / Default / Larger = 13 / 14 / 15px for
 * conversation text, plus a compact density that tightens the rhythm without
 * changing the type. Both are CSS variables on the root element
 * (`--buzz-type-rem`, `--conversation-*`), so this provider only writes an
 * attribute; nothing re-renders to apply them.
 */

export type FontSize = "smaller" | "default" | "larger";
export type Density = "comfortable" | "compact";

export const FONT_SIZE_STORAGE_KEY = "buzz.fontSize";
export const DENSITY_STORAGE_KEY = "buzz.conversationDensity";

type TypographyContextValue = {
  fontSize: FontSize;
  density: Density;
  setFontSize: (size: FontSize) => void;
  setDensity: (density: Density) => void;
};

const TypographyContext = createContext<TypographyContextValue | undefined>(
  undefined,
);

function readStored<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored && (allowed as readonly string[]).includes(stored)) {
      return stored as T;
    }
  } catch {
    // Storage unavailable: the default applies.
  }
  return fallback;
}

function apply(fontSize: FontSize, density: Density) {
  const root = document.documentElement;
  // `default` is the absence of the attribute, so the base CSS needs no
  // duplicate rule for it.
  if (fontSize === "default") delete root.dataset.fontSize;
  else root.dataset.fontSize = fontSize;
  if (density === "compact") root.dataset.conversationDensity = "compact";
  else delete root.dataset.conversationDensity;
}

export function TypographyProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSizeState] = useState<FontSize>(() =>
    readStored(
      FONT_SIZE_STORAGE_KEY,
      ["smaller", "default", "larger"],
      "default",
    ),
  );
  const [density, setDensityState] = useState<Density>(() =>
    readStored(DENSITY_STORAGE_KEY, ["comfortable", "compact"], "comfortable"),
  );

  useEffect(() => {
    apply(fontSize, density);
  }, [fontSize, density]);

  const setFontSize = useCallback((next: FontSize) => {
    setFontSizeState(next);
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, next);
    } catch {
      // Session-only, but the attribute still applies.
    }
  }, []);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // Session-only, but the attribute still applies.
    }
  }, []);

  return (
    <TypographyContext.Provider
      value={{ fontSize, density, setFontSize, setDensity }}
    >
      {children}
    </TypographyContext.Provider>
  );
}

export function useTypography(): TypographyContextValue {
  const value = useContext(TypographyContext);
  if (!value) {
    throw new Error("useTypography must be used inside TypographyProvider");
  }
  return value;
}
