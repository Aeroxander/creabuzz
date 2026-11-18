import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { identityDemoOffered } from "../lib/build-gates";

export const Route = createFileRoute("/identity-demo")({
  // A prototype for developers and the passkey specs; the hosted build leads home.
  beforeLoad: () => {
    if (!identityDemoOffered()) throw redirect({ to: "/", replace: true });
  },
  component: lazyRouteComponent(
    () => import("@/features/identity/ui/PasskeyCeremonyPage"),
    "PasskeyCeremonyPage",
  ),
});
