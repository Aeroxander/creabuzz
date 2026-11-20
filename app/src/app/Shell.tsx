import { serverWebPushKey } from "@creaton/core/client/server-settings.ts";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { RecoveryOfferHost } from "../features/account/RecoveryKeySheet";
import { TermsAgainHost } from "../features/account/TermsAgainHost";
import { UnlockBar } from "../features/account/UnlockBar";
import { useUnseenCount } from "../features/notifications/use-notifications";
import { ChunkBoundary } from "../ui/chunk-boundary";
import { WithMoneyBanner } from "./MoneyBanner";
import { TabBar } from "./TabBar";

// Saves this device's alerts at the server again before it forgets them; loaded only where the server sends alerts.
const PushRenewal = lazy(() => import("../features/alerts/push/PushRenewal"));

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
      {!signUp && serverWebPushKey() ? (
        <ChunkBoundary quiet>
          <Suspense fallback={null}>
            <PushRenewal />
          </Suspense>
        </ChunkBoundary>
      ) : null}
    </>
  );
}
