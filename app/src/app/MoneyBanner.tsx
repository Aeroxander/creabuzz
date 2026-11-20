/**
 * The fixed banner of every page (design 2.7): "You can take your money out any time. Nothing here promises a profit."
 * The shell draws it once under each page wherever the server offers investing. A page that draws its own (the project
 * page, the demo day page) says so with `useOwnBanner`, and the shell's steps aside: never two on a page. Sheets carry
 * the same words through `PotSheet`.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
} from "react";
import { TAKE_OUT_BANNER } from "../features/pot/pot-words";
import { investingOn } from "../lib/server";

/** What a page that draws its own banner calls to tell the shell: returns the call that takes it back. */
type Claim = () => () => void;
const ClaimContext = createContext<Claim | null>(null);

/** The banner's words as a line of text: one component for the shell's banner and for a page's own. */
export function BannerText({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-sm text-muted"} data-testid="money-banner">
      {TAKE_OUT_BANNER}
    </p>
  );
}

/**
 * Says that the page draws its own banner while `own` is true, so the shell does not draw a second one. The claim is made
 * before the screen is painted. Outside a shell (a test of the page alone) it does nothing.
 */
export function useOwnBanner(own = true) {
  const claim = useContext(ClaimContext);
  useLayoutEffect(() => (own && claim ? claim() : undefined), [own, claim]);
}

/**
 * Draws `children` (the page) and, under it, the banner: unless the server does not offer investing, `hidden` is set (the
 * sign-up screen), or a page has said it draws its own.
 */
export function WithMoneyBanner({
  children,
  hidden = false,
}: {
  children: ReactNode;
  hidden?: boolean;
}) {
  const [claims, setClaims] = useState(0);
  const claim = useCallback<Claim>(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const show = !hidden && claims === 0 && investingOn();
  return (
    <ClaimContext.Provider value={claim}>
      {children}
      {show ? (
        // Pulled up into the page's own room for the tab bar, so it sits just above the bar and not below the fold of it.
        <div
          className="mx-auto -mt-[calc(var(--tabbar-height)+var(--safe-bottom)+24px)] max-w-lg px-4 pb-[calc(var(--tabbar-height)+var(--safe-bottom)+16px)]"
          data-testid="shell-banner"
        >
          <BannerText />
        </div>
      ) : null}
    </ClaimContext.Provider>
  );
}
