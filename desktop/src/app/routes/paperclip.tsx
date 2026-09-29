import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const PaperclipView = React.lazy(async () => {
  const module = await import("@/features/paperclip/ui/PaperclipView");
  return { default: module.PaperclipView };
});

function PaperclipRoute() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="paperclip" />}>
      <PaperclipView />
    </React.Suspense>
  );
}

export const Route = createFileRoute("/paperclip")({
  component: PaperclipRouteComponent,
});

function PaperclipRouteComponent() {
  // Deprecated and hidden from the sidebar: a direct link says how to bring
  // the entry back rather than opening it silently.
  usePreviewFeatureWarning("paperclip");
  return <PaperclipRoute />;
}
