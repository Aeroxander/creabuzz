import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { linkDeviceOffered } from "../lib/build-gates";

export const Route = createFileRoute("/link-device")({
  // Only the desktop app asks for this page; a build without it leads home.
  beforeLoad: () => {
    if (!linkDeviceOffered()) throw redirect({ to: "/", replace: true });
  },
  component: lazyRouteComponent(
    () => import("@/features/identity/ui/LinkDevicePage"),
    "LinkDevicePage",
  ),
});
