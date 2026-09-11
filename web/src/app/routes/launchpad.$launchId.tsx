import { createFileRoute } from "@tanstack/react-router";
import { LaunchDetailPage } from "@/features/launchpad/ui/LaunchDetailPage";

export const Route = createFileRoute("/launchpad/$launchId")({
  validateSearch: (search: Record<string, unknown>) => ({
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
  }),
  component: LaunchDetailRoute,
});

function LaunchDetailRoute() {
  const { launchId } = Route.useParams();
  const { author } = Route.useSearch();
  return <LaunchDetailPage launchId={launchId} author={author} />;
}
