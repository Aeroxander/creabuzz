import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>) => ({
    // Node ids are unique per author, so a project address is
    // `?author=<founder hex>` — same shape as `/launchpad/$launchId`.
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
    // Directory handoff: `?action=join` opens the join dialog for the first
    // open role (Discover's "Request to join" / "Join"). Unknown values are
    // ignored, forward-compat with the launchpad's deep-link shape.
    action: search.action === "join" ? ("join" as const) : undefined,
  }),
  component: ProjectDetailRoute,
});

// Wrapper stays eager for `useParams`/`useSearch`; the page body loads on
// demand like the launchpad's detail route.
const ProjectDetailPage = lazyRouteComponent(
  () => import("@/features/projects/ui/ProjectDetailPage"),
  "ProjectDetailPage",
);

function ProjectDetailRoute() {
  const { projectId } = Route.useParams();
  const { author, action } = Route.useSearch();
  return (
    <ProjectDetailPage action={action} author={author} projectId={projectId} />
  );
}
