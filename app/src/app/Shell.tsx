import { Outlet, useRouterState } from "@tanstack/react-router";
import { RecoveryOfferHost } from "../features/account/RecoveryKeySheet";
import { TermsAgainHost } from "../features/account/TermsAgainHost";
import { UnlockBar } from "../features/account/UnlockBar";
import { useUnseenCount } from "../features/notifications/use-notifications";
import { WithMoneyBanner } from "./MoneyBanner";
import { TabBar } from "./TabBar";

/** Every screen: the gradient behind, the account notices on top, the screen, and the tab bar at the bottom. */
export function Shell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const signUp = path === "/welcome";
  const unseen = useUnseenCount();
  return (
    <>
      <div aria-hidden="true" className="app-bg" />
      {signUp ? null : (
        <>
          <TermsAgainHost />
          <UnlockBar />
        </>
      )}
      <WithMoneyBanner hidden={signUp}>
        <Outlet />
      </WithMoneyBanner>
      {signUp ? null : <TabBar badge={unseen} />}
      <RecoveryOfferHost />
    </>
  );
}
